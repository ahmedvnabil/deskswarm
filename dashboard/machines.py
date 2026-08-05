"""Everything about a machine except its routes.

Queries, the view a machine is rendered as, creation, and sleep/wake. The
routes on top of this are in routes/machines.py.
"""

import re
import threading
import time
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor

import requests
from flask import g, has_request_context, request

import fleet
from db import connect
from settings import MAX_BULK_CREATE, WAKE_TIMEOUT_SECONDS

# Picking the next free port and starting the container is a read-then-write:
# two concurrent creates would otherwise choose the same port and the second
# container would fail to bind.
_create_lock = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def list_computers() -> list[dict]:
    conn = connect()
    rows = [dict(r) for r in conn.execute("SELECT * FROM computers ORDER BY id")]
    conn.close()
    return rows


def get_computer(comp_id: int) -> dict | None:
    conn = connect()
    row = conn.execute("SELECT * FROM computers WHERE id = ?", (comp_id,)).fetchone()
    conn.close()
    if not row:
        return None
    # Nearly every per-machine handler starts here, so naming the machine for
    # the audit log once means no handler has to remember to do it.
    if has_request_context():
        g.audit_target = row["name"]
    return dict(row)


def get_computer_by_name(name: str) -> dict | None:
    conn = connect()
    row = conn.execute("SELECT * FROM computers WHERE name = ?", (name,)).fetchone()
    conn.close()
    return dict(row) if row else None


def browser_host() -> str | None:
    """The hostname the browser used to reach us.

    The machines' screens are published on this host's ports, so the link to
    them has to name a host the *browser* can reach. Deriving it from the
    request means opening the dashboard at a LAN address just works, instead
    of showing black screens until someone finds DESKSWARM_PUBLIC_HOST.
    """
    if not has_request_context():
        return None
    return request.host.rsplit(":", 1)[0] or None


def computer_view(comp: dict, with_state: bool = True, host: str | None = None) -> dict:
    view = {
        "id": comp["id"],
        "name": comp["name"],
        "slug": comp["slug"],
        "novnc_port": comp["novnc_port"],
        "novnc_url": fleet.novnc_url(comp["novnc_port"], comp["vnc_password"],
                                     host=host or browser_host()),
        "vnc_password": comp["vnc_password"],
        "bridge_host": fleet.bridge_container_name(comp["slug"]),
        "bridge_port": 8000,
        "created_at": comp["created_at"],
        "reserved": bool(comp["reserved"]),
        "no_suspend": bool(comp["no_suspend"]),
        "last_active_at": comp["last_active_at"],
        "bridge_ok": False,
        "sleeping": False,
    }
    if with_state:
        try:
            view.update(fleet.container_state(comp["slug"]))
        except Exception as exc:  # noqa: BLE001
            view["error"] = str(exc)
        view["sleeping"] = view.get("desktop_state") == "exited"
        # Probing a stopped bridge just burns the full HTTP timeout, once per
        # machine per refresh — on a wall of sleeping machines that alone made
        # the page slower than its own poll interval.
        if view.get("bridge_state") == "running":
            view["bridge_ok"] = check_bridge(view)
    return view


def check_bridge(view: dict) -> bool:
    try:
        r = requests.get(f"http://{view['bridge_host']}:{view['bridge_port']}/status", timeout=3)
        return r.status_code == 200 and r.json().get("status") == "ok"
    except Exception:  # noqa: BLE001
        return False


def computer_views(comps: list[dict]) -> list[dict]:
    """Build the view for every machine at once.

    Each machine costs two Docker inspects plus a bridge probe. Done serially
    that is a few hundred milliseconds per machine, so a wall of 24 would take
    longer to render than its own 5s refresh interval. Order is preserved.
    """
    if not comps:
        return []
    # Resolved here, not inside the workers: a thread has no request context,
    # so asking for it there would silently fall back to localhost.
    host = browser_host()
    with ThreadPoolExecutor(max_workers=min(16, len(comps))) as pool:
        return list(pool.map(lambda c: computer_view(c, host=host), comps))


def budgeted_machine_count() -> int:
    """Machines to charge against the memory budget: the awake ones.

    Falls back to the whole fleet if Docker can't be asked — over-counting is
    the safe direction for an admission check.
    """
    awake = fleet.awake_machine_count()
    return len(list_computers()) if awake is None else awake


RANGE_RE = re.compile(r"\{(\d+)\.\.(\d+)\}")


def expand_names(pattern: str) -> list[str]:
    """Expand one brace range so a whole batch can be added at once.

    'agent-{1..3}'  -> agent-1, agent-2, agent-3
    'node-{01..03}' -> node-01, node-02, node-03  (zero-padding is preserved)

    Plain names come back unchanged, so the single-machine path is the same
    code path as the bulk one.
    """
    m = RANGE_RE.search(pattern)
    if not m:
        return [pattern]
    lo_raw, hi_raw = m.group(1), m.group(2)
    lo, hi = int(lo_raw), int(hi_raw)
    if hi < lo:
        raise ValueError(f"range {{{lo_raw}..{hi_raw}}} counts backwards")
    if hi - lo + 1 > MAX_BULK_CREATE:
        raise ValueError(f"range expands to more than {MAX_BULK_CREATE} machines")
    width = len(lo_raw) if lo_raw.startswith("0") else 0
    return [
        pattern[: m.start()] + (str(i).zfill(width) if width else str(i)) + pattern[m.end():]
        for i in range(lo, hi + 1)
    ]


def create_one_computer(conn, name: str, image: str | None) -> dict:
    """Insert + boot a single machine. Raises ValueError for user-facing
    problems so the bulk path can report them per-name."""
    slug = fleet.slugify(name)
    clash = conn.execute(
        "SELECT 1 FROM computers WHERE name = ? OR slug = ?", (name, slug)
    ).fetchone()
    if clash:
        raise ValueError(f"'{name}' already exists")

    with _create_lock:
        reserved = {r["novnc_port"] for r in conn.execute("SELECT novnc_port FROM computers")}
        port = fleet.next_novnc_port(reserved)
        password = fleet.random_vnc_password()
        fleet.create_computer(slug, port, password, image=image)

    conn.execute(
        "INSERT INTO computers (name, slug, novnc_port, vnc_password, image, created_at) "
        "VALUES (?,?,?,?,?,?)",
        (name, slug, port, password, image, now_iso()),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM computers WHERE slug = ?", (slug,)).fetchone()
    return computer_view(dict(row), with_state=False)


def touch_active(comp_id: int) -> None:
    conn = connect()
    conn.execute("UPDATE computers SET last_active_at = ? WHERE id = ?", (now_iso(), comp_id))
    conn.commit()
    conn.close()


def _wait_for_bridge(slug: str, timeout: float) -> bool:
    view = {"bridge_host": fleet.bridge_container_name(slug), "bridge_port": 8000}
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check_bridge(view):
            return True
        time.sleep(1.5)
    return False


def wake_and_wait(comp: dict, timeout: float | None = None) -> dict:
    """Start a sleeping machine and block until its bridge answers.

    Callers need the machine actually usable, not merely started: a desktop
    takes a few seconds to bring up X and the bridge a few more to attach.
    Returning as soon as Docker says "started" would hand back a machine whose
    screen is still black and whose first command fails.

    A container that is started rather than created keeps the filesystem of its
    previous life, and that is a reliable source of processes which refuse to
    start twice — stale lock files, sockets, pid files. When the bridge doesn't
    come back, recreating the pair clears all of it. The home volume survives
    either way, so the cost is the container's own scratch state, which is a
    fair price for a machine that works. It is reported rather than hidden.
    """
    # Read at call time, not as a default argument: a default binds once at
    # import and then silently ignores anything that changes the setting.
    timeout = WAKE_TIMEOUT_SECONDS if timeout is None else timeout
    fleet.resume_computer(comp["slug"])
    touch_active(comp["id"])
    if _wait_for_bridge(comp["slug"], timeout):
        return {"ready": True, "recreated": False}

    try:
        fleet.destroy_computer(comp["slug"], keep_home=True)
        fleet.create_computer(comp["slug"], comp["novnc_port"],
                              comp["vnc_password"], image=comp["image"])
    except Exception:  # noqa: BLE001
        return {"ready": False, "recreated": False}
    return {"ready": _wait_for_bridge(comp["slug"], timeout), "recreated": True}
