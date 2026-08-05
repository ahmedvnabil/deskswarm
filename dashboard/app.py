import base64
import csv
import io
import re
import json
import os
import signal
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from functools import wraps
from pathlib import Path
from urllib.parse import urlparse

from flask import (Flask, Response, abort, g, has_request_context, jsonify,
                   render_template, request)

import requests

import audit
import backups
import db
import fleet
import guards
import shares

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("DESKSWARM_DB_PATH", str(BASE_DIR / "data" / "fleet.db")))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("DESKSWARM_DB_PATH", str(DB_PATH))

RUN_TASK_SCRIPT = str(BASE_DIR / "run_task.py")
TASK_TIMEOUT_SECONDS = int(os.environ.get("DESKSWARM_TASK_TIMEOUT", "300"))
DASHBOARD_TOKEN = os.environ.get("DASHBOARD_TOKEN")
MAX_BULK_CREATE = int(os.environ.get("DESKSWARM_MAX_BULK_CREATE", "25"))
PAGE_SIZE = int(os.environ.get("DESKSWARM_PAGE_SIZE", "25"))

app = Flask(__name__)

# Picking the next free port and starting the container is a read-then-write:
# two concurrent creates would otherwise choose the same port and the second
# container would fail to bind.
_create_lock = threading.Lock()

# A task costs a subprocess plus an agent session. Without a ceiling, "run on
# the whole fleet" across a large fleet would start them all at once.
MAX_CONCURRENT_TASKS = int(os.environ.get("DESKSWARM_MAX_CONCURRENT_TASKS", "8"))
_task_slots = threading.BoundedSemaphore(MAX_CONCURRENT_TASKS)


SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


@app.before_request
def block_cross_site():
    """Reject state-changing requests that a *browser* sends from another site.

    Without this, any page the user visits could auto-submit a plain HTML form
    at this dashboard. Form posts are "simple requests", so they are sent with
    no CORS preflight to stop them — and POST /computers/<id>/exec runs a shell
    command as root inside a machine. That is remote code execution triggered
    by nothing more than visiting a web page.

    Browsers always attach Origin to a cross-site state-changing request, so
    rejecting a *present but foreign* Origin closes the hole. Non-browser
    clients (curl, n8n, cron) send no Origin at all and keep working; they are
    not a CSRF vector because no one else controls them.
    """
    if request.method in SAFE_METHODS:
        return None
    source = request.headers.get("Origin") or request.headers.get("Referer")
    if not source:
        return None
    if urlparse(source).netloc != request.host:
        return jsonify({"ok": False, "data": None,
                        "error": "cross-site request blocked"}), 403
    return None


@app.after_request
def write_audit(response):
    """Record every state-changing request, once, in one place.

    Deliberately a hook rather than a call inside each handler: a log you have
    to remember to write is a log with holes, and the holes land in whichever
    endpoint was added last — usually the interesting one.

    Handlers add context by setting `g.audit_target` / `g.audit_detail`. What
    they must not put there is content: the shell command is recorded because
    that is the whole point, but clipboard text and file bodies are only ever
    counted.
    """
    try:
        if audit.should_record(request.method, request.path):
            audit.record(
                f"{request.method} {request.path}",
                actor=getattr(g, "actor", "dashboard"),
                source_ip=request.headers.get("X-Forwarded-For",
                                              request.remote_addr or "").split(",")[0].strip(),
                target=getattr(g, "audit_target", None),
                detail=getattr(g, "audit_detail", None),
                status=response.status_code,
                ok=response.status_code < 400,
            )
    except Exception:  # noqa: BLE001
        pass          # an audit failure must never break the request itself
    return response


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def require_token(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not DASHBOARD_TOKEN:
            return fn(*args, **kwargs)
        supplied = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if supplied != DASHBOARD_TOKEN:
            return jsonify({"ok": False, "data": None, "error": "unauthorized"}), 401
        return fn(*args, **kwargs)
    return wrapper


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    conn = g.pop("db", None)      # not `db` — that is the module now
    if conn is not None:
        conn.close()


# One definition, shared with the feature modules, which need connections of
# their own outside a request context.
connect = db.connect


def init_db():
    conn = connect()
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            desktop TEXT NOT NULL,
            description TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'PENDING',
            current_action TEXT,
            result_text TEXT,
            actions TEXT,
            cost_usd REAL,
            error TEXT,
            pid INTEGER,
            started_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS computers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            slug TEXT NOT NULL UNIQUE,
            novnc_port INTEGER NOT NULL,
            vnc_password TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            image TEXT NOT NULL,
            source TEXT,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            desktop TEXT NOT NULL,
            description TEXT NOT NULL,
            kind TEXT NOT NULL,              -- 'interval' | 'daily'
            every_minutes INTEGER,           -- for kind='interval'
            at_time TEXT,                    -- 'HH:MM' UTC, for kind='daily'
            enabled INTEGER NOT NULL DEFAULT 1,
            next_run_at TEXT NOT NULL,
            last_run_at TEXT,
            run_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
        """
    )
    comp_cols = {row[1] for row in conn.execute("PRAGMA table_info(computers)")}
    if "image" not in comp_cols:
        conn.execute("ALTER TABLE computers ADD COLUMN image TEXT")
    if "reserved" not in comp_cols:
        # A reserved machine is yours to drive by hand; agents keep off it.
        conn.execute("ALTER TABLE computers ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0")
    if "last_active_at" not in comp_cols:
        # Last time a browser had the screen open or a task was running on it.
        conn.execute("ALTER TABLE computers ADD COLUMN last_active_at TEXT")
    if "no_suspend" not in comp_cols:
        # Machines the idle sweeper must leave alone whatever the timeout says.
        conn.execute("ALTER TABLE computers ADD COLUMN no_suspend INTEGER NOT NULL DEFAULT 0")

    audit.init(conn)
    shares.init(conn)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

    existing = {row[1] for row in conn.execute("PRAGMA table_info(tasks)")}
    for col, decl in (("current_action", "TEXT"), ("pid", "INTEGER"), ("started_at", "TEXT")):
        if col not in existing:
            conn.execute(f"ALTER TABLE tasks ADD COLUMN {col} {decl}")
    conn.commit()
    conn.close()


# ---------------------------------------------------------------- computers

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


def computer_view(comp: dict, with_state: bool = True) -> dict:
    view = {
        "id": comp["id"],
        "name": comp["name"],
        "slug": comp["slug"],
        "novnc_port": comp["novnc_port"],
        "novnc_url": fleet.novnc_url(comp["novnc_port"], comp["vnc_password"]),
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
    with ThreadPoolExecutor(max_workers=min(16, len(comps))) as pool:
        return list(pool.map(computer_view, comps))


def budgeted_machine_count() -> int:
    """Machines to charge against the memory budget: the awake ones.

    Falls back to the whole fleet if Docker can't be asked — over-counting is
    the safe direction for an admission check.
    """
    awake = fleet.awake_machine_count()
    return len(list_computers()) if awake is None else awake


# -------------------------------------------------------------------- tasks

def create_task_row(desktop: str, description: str) -> int:
    conn = connect()
    ts = now_iso()
    cur = conn.execute(
        "INSERT INTO tasks (desktop, description, status, created_at, updated_at) "
        "VALUES (?, ?, 'PENDING', ?, ?)",
        (desktop, description, ts, ts),
    )
    conn.commit()
    task_id = cur.lastrowid
    conn.close()
    return task_id


def update_task_row(task_id: int, **fields):
    conn = connect()
    fields["updated_at"] = now_iso()
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", (*fields.values(), task_id))
    conn.commit()
    conn.close()


def get_task_row(task_id: int) -> dict | None:
    conn = connect()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def run_task_worker(task_id: int, bridge_host: str, bridge_port: int, description: str):
    # Queue behind the slot limit; the row stays PENDING and visible until a
    # slot frees up, so a fleet-wide dispatch drains instead of stampeding.
    with _task_slots:
        _run_task_worker(task_id, bridge_host, bridge_port, description)


def _run_task_worker(task_id: int, bridge_host: str, bridge_port: int, description: str):
    current = get_task_row(task_id)
    if current and current.get("status") == "CANCELLED":
        return  # cancelled while it was still queued
    update_task_row(task_id, status="RUNNING", started_at=now_iso(), current_action="starting")
    try:
        proc = subprocess.Popen(
            [sys.executable, RUN_TASK_SCRIPT, str(task_id), bridge_host, str(bridge_port), description],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        update_task_row(task_id, pid=proc.pid)
        try:
            stdout, stderr = proc.communicate(timeout=TASK_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            update_task_row(task_id, status="FAILED", pid=None, current_action=None,
                            error=f"timed out after {TASK_TIMEOUT_SECONDS}s")
            return

        current = get_task_row(task_id)
        if current and current.get("status") == "CANCELLED":
            return

        last_line = None
        for line in stdout.splitlines():
            line = line.strip()
            if line.startswith("{"):
                last_line = line
        if last_line is None:
            update_task_row(task_id, status="FAILED", pid=None, current_action=None,
                            error=(stderr or "no output")[-2000:])
            return
        payload = json.loads(last_line)
        update_task_row(task_id, status="COMPLETED", pid=None, current_action=None,
                        result_text=payload.get("final_text"),
                        actions=json.dumps(payload.get("actions") or []),
                        cost_usd=payload.get("cost_usd"))
    except Exception as exc:  # noqa: BLE001
        update_task_row(task_id, status="FAILED", pid=None, current_action=None, error=str(exc)[-2000:])


def compute_duration_seconds(row: dict) -> float | None:
    start, end = row.get("started_at"), row.get("updated_at")
    if not start or row.get("status") in ("PENDING", "RUNNING"):
        return None
    try:
        return round((datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds(), 1)
    except Exception:  # noqa: BLE001
        return None


def build_analytics() -> dict:
    db = get_db()
    rows = [dict(r) for r in db.execute("SELECT * FROM tasks").fetchall()]
    by_status = {"PENDING": 0, "RUNNING": 0, "COMPLETED": 0, "FAILED": 0, "CANCELLED": 0}
    total_cost, durations, per_desktop = 0.0, [], {}

    for r in rows:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
        if r.get("cost_usd"):
            total_cost += r["cost_usd"]
        d = compute_duration_seconds(r)
        if d is not None:
            durations.append(d)
        pd = per_desktop.setdefault(r["desktop"], {"name": r["desktop"], "total": 0, "completed": 0, "failed": 0, "cost_usd": 0.0})
        pd["total"] += 1
        if r["status"] == "COMPLETED":
            pd["completed"] += 1
        elif r["status"] == "FAILED":
            pd["failed"] += 1
        if r.get("cost_usd"):
            pd["cost_usd"] += r["cost_usd"]

    live_names = {c["name"] for c in list_computers()}
    for pd in per_desktop.values():
        pd["exists"] = pd["name"] in live_names

    finished = by_status["COMPLETED"] + by_status["FAILED"]
    daily_rows = db.execute(
        """
        SELECT date(updated_at) AS day, COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost
        FROM tasks WHERE status IN ('COMPLETED','FAILED')
        GROUP BY day ORDER BY day DESC LIMIT 14
        """
    ).fetchall()

    return {
        "total": len(rows),
        "by_status": by_status,
        "success_rate": round(100 * by_status["COMPLETED"] / finished, 1) if finished else None,
        "total_cost_usd": round(total_cost, 4),
        "avg_duration_seconds": round(sum(durations) / len(durations), 1) if durations else None,
        "per_desktop": sorted(
            per_desktop.values(), key=lambda d: (not d["exists"], d["name"])
        ),
        "daily": [{"day": r["day"], "count": r["n"], "cost": round(r["cost"], 4)} for r in daily_rows][::-1],
    }


# ------------------------------------------------------------------- routes

@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/")
def index():
    return render_template("index.html", computers=list_computers())


def active_task_by_computer() -> dict[str, dict]:
    """Newest in-flight task per computer name, so a card can show what its
    agent is doing right now instead of just whether the bridge is up."""
    conn = connect()
    rows = conn.execute(
        "SELECT id, desktop, description, status, current_action FROM tasks "
        "WHERE status IN ('PENDING', 'RUNNING') ORDER BY id DESC"
    ).fetchall()
    conn.close()
    busy: dict[str, dict] = {}
    for r in rows:
        busy.setdefault(r["desktop"], dict(r))
    return busy


@app.route("/partials/fleet")
def partial_fleet():
    busy = active_task_by_computer()
    computers = computer_views(list_computers())
    for view in computers:
        view["active_task"] = busy.get(view["name"])
    return render_template("_fleet.html", computers=computers,
                           shot_token=int(time.time() // SHOT_TTL))


@app.route("/partials/tasks")
def partial_tasks():
    desktop = (request.args.get("desktop") or "").strip()
    status = (request.args.get("status") or "").strip().upper()
    try:
        page = max(1, int(request.args.get("page") or 1))
    except ValueError:
        page = 1

    where, params = [], []
    if desktop:
        where.append("desktop = ?")
        params.append(desktop)
    if status == "ACTIVE":
        where.append("status IN ('PENDING', 'RUNNING')")
    elif status in ("COMPLETED", "FAILED", "CANCELLED"):
        where.append("status = ?")
        params.append(status)
    clause = (" WHERE " + " AND ".join(where)) if where else ""

    db = get_db()
    total = db.execute(f"SELECT COUNT(*) c FROM tasks{clause}", params).fetchone()["c"]
    pages = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
    page = min(page, pages)
    rows = [dict(r) for r in db.execute(
        f"SELECT * FROM tasks{clause} ORDER BY id DESC LIMIT ? OFFSET ?",
        (*params, PAGE_SIZE, (page - 1) * PAGE_SIZE),
    ).fetchall()]
    for r in rows:
        r["duration_seconds"] = compute_duration_seconds(r)

    return render_template(
        "_tasks.html",
        tasks=rows,
        names=[c["name"] for c in list_computers()],
        sel_desktop=desktop,
        sel_status=status,
        page=page, pages=pages, total=total,
    )


@app.route("/partials/schedules")
def partial_schedules():
    conn = connect()
    rows = [dict(r) for r in conn.execute("SELECT * FROM schedules ORDER BY id DESC")]
    conn.close()
    return render_template("_schedules.html", schedules=rows)


@app.route("/partials/analytics")
def partial_analytics():
    return render_template("_analytics.html", analytics=build_analytics())


@app.route("/api/v1/computers", methods=["GET"])
def api_computers_list():
    return jsonify({"ok": True, "data": computer_views(list_computers()), "error": None})


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


@app.route("/api/v1/computers", methods=["POST"])
@require_token
def api_computers_create():
    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or "").strip()
    snapshot_name = (payload.get("snapshot") or "").strip()
    if not name:
        return jsonify({"ok": False, "data": None, "error": "name is required"}), 400

    image = None
    if snapshot_name:
        conn = connect()
        snap = conn.execute("SELECT * FROM snapshots WHERE name = ?", (snapshot_name,)).fetchone()
        conn.close()
        if not snap:
            return jsonify({"ok": False, "data": None,
                            "error": f"unknown snapshot '{snapshot_name}'"}), 400
        image = snap["image"]

    try:
        names = expand_names(name)
    except ValueError as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400

    fleet_size = budgeted_machine_count()
    for ok, msg in (guards.check_memory(len(names), fleet_size), guards.check_disk()):
        if not ok:
            return jsonify({"ok": False, "data": None, "error": msg}), 507

    conn = connect()
    created, errors = [], []
    for n in names:
        try:
            created.append(create_one_computer(conn, n, image))
        except ValueError as exc:
            errors.append({"name": n, "error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            errors.append({"name": n, "error": f"failed to start containers: {exc}"})
    conn.close()

    if not created:
        msg = errors[0]["error"] if errors else "nothing created"
        code = 409 if errors and "already exists" in errors[0]["error"] else 500
        return jsonify({"ok": False, "data": {"errors": errors}, "error": msg}), code

    # Creation is the one mutation with no machine to look up beforehand, so
    # the audit target has to be named here rather than by get_computer.
    g.audit_target = names[0] if len(names) == 1 else None
    g.audit_detail = (f"created {len(created)}" +
                      (f", {len(errors)} failed" if errors else "") +
                      (f" ({', '.join(c['name'] for c in created[:8])})"
                       if len(names) > 1 else ""))

    # Single-name requests keep returning the bare object they always did.
    data = created[0] if len(names) == 1 else {"created": created, "errors": errors}
    return jsonify({"ok": True, "data": data, "error": None}), 201


@app.route("/api/v1/computers/<int:comp_id>", methods=["PATCH"])
@require_token
def api_computers_rename(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    payload = request.get_json(silent=True) or {}

    # Same endpoint also flips the boolean flags, which carry no name.
    for field in ("reserved", "no_suspend"):
        if field in payload and "name" not in payload:
            flag = 1 if str(payload[field]).lower() in ("1", "true", "yes") else 0
            conn = connect()
            conn.execute(f"UPDATE computers SET {field} = ? WHERE id = ?", (flag, comp_id))
            conn.commit()
            conn.close()
            return jsonify({"ok": True, "data": {"id": comp_id, field: bool(flag)},
                            "error": None})

    new_name = (payload.get("name") or "").strip()
    if not new_name:
        return jsonify({"ok": False, "data": None, "error": "name is required"}), 400

    conn = connect()
    clash = conn.execute("SELECT 1 FROM computers WHERE name = ? AND id != ?", (new_name, comp_id)).fetchone()
    if clash:
        conn.close()
        return jsonify({"ok": False, "data": None, "error": f"'{new_name}' already exists"}), 409
    # Only the display name changes — the slug stays, so containers and any
    # in-flight task keep pointing at the same machine.
    conn.execute("UPDATE computers SET name = ? WHERE id = ?", (new_name, comp_id))
    conn.execute("UPDATE tasks SET desktop = ? WHERE desktop = ?", (new_name, comp["name"]))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "data": {"id": comp_id, "name": new_name}, "error": None})


@app.route("/api/v1/computers/<int:comp_id>/restart", methods=["POST"])
@require_token
def api_computer_restart(comp_id: int):
    """Recreate a machine's containers in place.

    A machine can end up with its containers gone or wedged — the host
    rebooted, someone ran `docker rm`, the bridge died. Before this the only
    cure was delete-and-recreate, which lost the machine's name and port.
    """
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    try:
        # keep_home: a restart is meant to fix the machine, not wipe your work.
        fleet.destroy_computer(comp["slug"], keep_home=True)
        fleet.create_computer(comp["slug"], comp["novnc_port"],
                              comp["vnc_password"], image=comp["image"])
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None,
                        "error": f"failed to restart: {exc}"}), 500
    return jsonify({"ok": True, "data": {"id": comp_id, "restarted": True}, "error": None})


# --------------------------------------------------------------- sleep/wake

IDLE_SUSPEND_MINUTES = int(os.environ.get("DESKSWARM_IDLE_SUSPEND_MINUTES", "0"))
WAKE_TIMEOUT_SECONDS = float(os.environ.get("DESKSWARM_WAKE_TIMEOUT", "45"))


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


@app.route("/api/v1/computers/<int:comp_id>/sleep", methods=["POST"])
@require_token
def api_computer_sleep(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    conn = connect()
    busy = conn.execute(
        "SELECT COUNT(*) AS n FROM tasks WHERE desktop = ? AND status IN ('PENDING','RUNNING')",
        (comp["name"],),
    ).fetchone()["n"]
    conn.close()
    if busy:
        return jsonify({"ok": False, "data": None,
                        "error": f"{comp['name']} has {busy} task(s) still running"}), 409
    try:
        fleet.suspend_computer(comp["slug"])
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": f"failed to sleep: {exc}"}), 500
    return jsonify({"ok": True, "data": {"id": comp_id, "sleeping": True}, "error": None})


@app.route("/api/v1/computers/<int:comp_id>/wake", methods=["POST"])
@require_token
def api_computer_wake(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    try:
        result = wake_and_wait(comp)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": f"failed to wake: {exc}"}), 500
    # Started but not yet answering is not an error — the screen will come up
    # a moment later — so this reports readiness rather than failing.
    return jsonify({"ok": True, "data": {"id": comp_id, "sleeping": False, **result},
                    "error": None})


# --------------------------------------------------------------- clipboard

MAX_CLIPBOARD_KB = int(os.environ.get("DESKSWARM_MAX_CLIPBOARD_KB", "256"))


@app.route("/api/v1/computers/<int:comp_id>/clipboard", methods=["GET"])
def api_clipboard_get(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    try:
        text = fleet.get_clipboard(comp["slug"])
    except fleet.ClipboardUnavailable as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 503
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 500
    return jsonify({"ok": True, "data": {"text": text}, "error": None})


@app.route("/api/v1/computers/<int:comp_id>/clipboard", methods=["POST"])
@require_token
def api_clipboard_set(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    payload = request.get_json(silent=True) or {}
    text = payload.get("text")
    if text is None:
        return jsonify({"ok": False, "data": None, "error": "text is required"}), 400
    text = str(text)
    if len(text.encode("utf-8")) > MAX_CLIPBOARD_KB * 1024:
        return jsonify({"ok": False, "data": None,
                        "error": f"clipboard text over {MAX_CLIPBOARD_KB} KB"}), 413
    # "paste" also presses Ctrl+V, which is what makes Arabic typing work at
    # all — see fleet.paste_text.
    press = str(payload.get("paste", "")).lower() in ("1", "true", "yes")
    # Size and intent, not the text — an audit trail that archives everything
    # anyone pasted is its own kind of problem.
    g.audit_detail = f"{len(text.encode('utf-8'))} bytes, paste={press}"
    try:
        (fleet.paste_text if press else fleet.set_clipboard)(comp["slug"], text)
    except fleet.ClipboardUnavailable as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 503
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 500
    touch_active(comp_id)
    return jsonify({"ok": True, "data": {"id": comp_id, "bytes": len(text.encode("utf-8")),
                                         "pasted": press}, "error": None})


@app.route("/api/v1/computers/<int:comp_id>", methods=["DELETE"])
@require_token
def api_computers_delete(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    try:
        fleet.destroy_computer(comp["slug"])
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": f"failed to remove containers: {exc}"}), 500
    conn = connect()
    conn.execute("DELETE FROM computers WHERE id = ?", (comp_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "data": {"id": comp_id, "removed": True}, "error": None})


@app.route("/api/v1/computers/<int:comp_id>/inventory", methods=["GET"])
def api_computers_inventory(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    try:
        data = fleet.get_inventory(comp["slug"])
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 500
    return jsonify({"ok": True, "data": data, "error": None})


@app.route("/partials/computers/<int:comp_id>/inventory")
def partial_inventory(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return "<div class='text-red-400 text-xs'>computer not found</div>", 404
    try:
        inv = fleet.get_inventory(comp["slug"])
    except Exception as exc:  # noqa: BLE001
        inv = {"error": str(exc)}
    return render_template("_inventory.html", comp=comp, inv=inv,
                           vnc_password=comp["vnc_password"])


@app.route("/api/v1/computers/<int:comp_id>/exec", methods=["POST"])
@require_token
def api_computers_exec(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    payload = request.get_json(silent=True) or {}
    command = (payload.get("command") or "").strip()
    if not command:
        return jsonify({"ok": False, "data": None, "error": "command is required"}), 400
    g.audit_detail = command[:500]
    try:
        result = fleet.exec_in_desktop(comp["slug"], command)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 500
    return jsonify({"ok": True, "data": result, "error": None})


@app.route("/api/v1/fleet")
def api_fleet():
    return jsonify({"ok": True, "data": computer_views(list_computers()), "error": None})


# --------------------------------------------------------------------- files

MAX_UPLOAD_MB = int(os.environ.get("DESKSWARM_MAX_UPLOAD_MB", "64"))


@app.route("/api/v1/computers/<int:comp_id>/files")
def api_files_list(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    rel = request.args.get("path", "")
    try:
        entries = fleet.list_home(comp["slug"], rel)
    except fleet.PathOutsideHome as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400
    except FileNotFoundError:
        return jsonify({"ok": False, "data": None, "error": f"no such folder: {rel}"}), 404
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 500
    return jsonify({"ok": True, "error": None,
                    "data": {"path": rel, "entries": entries}})


@app.route("/api/v1/computers/<int:comp_id>/files", methods=["POST"])
@require_token
def api_files_upload(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        return jsonify({"ok": False, "data": None, "error": "no file supplied"}), 400

    data = uploaded.read()
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        return jsonify({"ok": False, "data": None,
                        "error": f"file is larger than {MAX_UPLOAD_MB} MB"}), 413

    # Land on the Desktop by default: the point is that you can see it.
    rel_dir = request.form.get("path") or "Desktop"
    name = os.path.basename(uploaded.filename)
    try:
        path = fleet.upload_to_home(comp["slug"], rel_dir, name, data)
    except fleet.PathOutsideHome as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 500
    return jsonify({"ok": True, "error": None,
                    "data": {"path": path, "bytes": len(data)}}), 201


@app.route("/api/v1/computers/<int:comp_id>/files/download")
def api_files_download(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    rel = request.args.get("path", "")
    if not rel:
        return jsonify({"ok": False, "data": None, "error": "path is required"}), 400
    try:
        blob, name, _ = fleet.download_from_home(comp["slug"], rel)
    except fleet.PathOutsideHome as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 404
    return Response(blob, mimetype="application/octet-stream", headers={
        "Content-Disposition": f'attachment; filename="{name}"'})


@app.route("/partials/computers/<int:comp_id>/files")
def partial_files(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return "<div class='text-red-400 text-sm'>not found</div>", 404
    rel = request.args.get("path", "")
    try:
        entries = fleet.list_home(comp["slug"], rel)
        error = None
    except Exception as exc:  # noqa: BLE001
        entries, error = [], str(exc)
    parent = os.path.dirname(rel.rstrip("/")) if rel else None
    return render_template("_files.html", comp=comp, entries=entries, path=rel,
                           parent=parent, error=error, max_mb=MAX_UPLOAD_MB)


# --------------------------------------------------------------- screenshots
# The wall shows every machine at once. Opening a live VNC stream per tile
# would mean N simultaneous connections, so tiles poll a cached still instead
# and only the tile you click gets a real interactive session.

_SHOT_CACHE: dict[str, tuple[float, bytes]] = {}
SHOT_TTL = float(os.environ.get("DESKSWARM_SHOT_TTL", "3"))


def bridge_screenshot(view: dict) -> bytes | None:
    """Grab a PNG of one machine's screen through its bridge."""
    slug = view["slug"]
    now = time.time()
    hit = _SHOT_CACHE.get(slug)
    if hit and now - hit[0] < SHOT_TTL:
        return hit[1]

    url = f"http://{view['bridge_host']}:{view['bridge_port']}/cmd"
    try:
        r = requests.post(url, json={"command": "screenshot", "params": {}}, timeout=12)
    except Exception:  # noqa: BLE001
        return None
    if r.status_code != 200:
        return None

    # The bridge answers as an SSE-ish stream: `data: {json}`.
    payload = None
    for line in r.text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if line.startswith("{"):
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
    if not payload or not payload.get("success") or not payload.get("image_data"):
        return None

    try:
        png = base64.b64decode(payload["image_data"])
    except Exception:  # noqa: BLE001
        return None
    _SHOT_CACHE[slug] = (now, png)
    return png


@app.route("/api/v1/computers/<int:comp_id>/screenshot")
def api_computer_screenshot(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    # A sleeping machine has no screen to capture. Saying so immediately beats
    # spending the bridge's full 12s timeout on every tile, every refresh.
    try:
        if fleet.container_state(comp["slug"]).get("desktop_state") == "exited":
            return jsonify({"ok": False, "data": None, "error": "sleeping"}), 503
    except Exception:  # noqa: BLE001
        pass
    png = bridge_screenshot(computer_view(comp, with_state=False))
    if png is None:
        return jsonify({"ok": False, "data": None, "error": "screen unavailable"}), 503
    return Response(png, mimetype="image/png",
                    headers={"Cache-Control": f"max-age={int(SHOT_TTL)}"})


# ---------------------------------------------------------------- snapshots

@app.route("/api/v1/snapshots")
def api_snapshots_list():
    conn = connect()
    rows = [dict(r) for r in conn.execute("SELECT * FROM snapshots ORDER BY id DESC")]
    conn.close()
    return jsonify({"ok": True, "data": rows, "error": None})


@app.route("/api/v1/computers/<int:comp_id>/snapshot", methods=["POST"])
@require_token
def api_computer_snapshot(comp_id: int):
    """Freeze a provisioned machine into a reusable image."""
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404

    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "data": None, "error": "name is required"}), 400

    ok, msg = guards.check_disk()
    if not ok:
        return jsonify({"ok": False, "data": None, "error": msg}), 507

    conn = connect()
    if conn.execute("SELECT 1 FROM snapshots WHERE name = ?", (name,)).fetchone():
        conn.close()
        return jsonify({"ok": False, "data": None, "error": f"snapshot '{name}' already exists"}), 409

    try:
        image = fleet.snapshot_computer(comp["slug"], fleet.slugify(name))
    except Exception as exc:  # noqa: BLE001
        conn.close()
        return jsonify({"ok": False, "data": None, "error": f"snapshot failed: {exc}"}), 500

    conn.execute(
        "INSERT INTO snapshots (name, image, source, created_at) VALUES (?,?,?,?)",
        (name, image, comp["name"], now_iso()),
    )
    conn.commit()
    row = dict(conn.execute("SELECT * FROM snapshots WHERE name = ?", (name,)).fetchone())
    conn.close()
    return jsonify({"ok": True, "data": row, "error": None}), 201


@app.route("/api/v1/snapshots/<int:snap_id>", methods=["DELETE"])
@require_token
def api_snapshot_delete(snap_id: int):
    conn = connect()
    row = conn.execute("SELECT * FROM snapshots WHERE id = ?", (snap_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    in_use = conn.execute("SELECT COUNT(*) c FROM computers WHERE image = ?", (row["image"],)).fetchone()["c"]
    conn.execute("DELETE FROM snapshots WHERE id = ?", (snap_id,))
    conn.commit()
    conn.close()
    # Only drop the image when nothing is running off it.
    if not in_use:
        try:
            fleet.remove_image(row["image"])
        except Exception:  # noqa: BLE001
            pass
    return jsonify({"ok": True, "data": {"id": snap_id, "removed": True,
                                         "image_kept": bool(in_use)}, "error": None})


# ---------------------------------------------------------------- schedules

def compute_next_run(kind: str, every_minutes: int | None, at_time: str | None,
                     after: datetime | None = None) -> str:
    now = after or datetime.now(timezone.utc)
    if kind == "interval":
        return (now + timedelta(minutes=every_minutes or 60)).isoformat(timespec="seconds")
    hh, mm = (at_time or "09:00").split(":")
    nxt = now.replace(hour=int(hh), minute=int(mm), second=0, microsecond=0)
    if nxt <= now:
        nxt += timedelta(days=1)
    return nxt.isoformat(timespec="seconds")


@app.route("/api/v1/schedules")
def api_schedules_list():
    conn = connect()
    rows = [dict(r) for r in conn.execute("SELECT * FROM schedules ORDER BY id DESC")]
    conn.close()
    return jsonify({"ok": True, "data": rows, "error": None})


@app.route("/api/v1/schedules", methods=["POST"])
@require_token
def api_schedules_create():
    payload = request.get_json(silent=True) or {}
    description = (payload.get("description") or "").strip()
    desktop = (payload.get("desktop") or "all").strip()
    kind = (payload.get("kind") or "interval").strip()

    if not description:
        return jsonify({"ok": False, "data": None, "error": "description is required"}), 400
    if kind not in ("interval", "daily"):
        return jsonify({"ok": False, "data": None, "error": "kind must be 'interval' or 'daily'"}), 400

    every_minutes, at_time = None, None
    if kind == "interval":
        try:
            every_minutes = int(payload.get("every_minutes") or 60)
        except ValueError:
            return jsonify({"ok": False, "data": None, "error": "every_minutes must be a number"}), 400
        if every_minutes < 1:
            return jsonify({"ok": False, "data": None, "error": "every_minutes must be >= 1"}), 400
    else:
        at_time = (payload.get("at_time") or "").strip()
        if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", at_time):
            return jsonify({"ok": False, "data": None, "error": "at_time must be HH:MM (24h UTC)"}), 400

    if desktop != "all" and not get_computer_by_name(desktop):
        return jsonify({"ok": False, "data": None, "error": f"unknown computer '{desktop}'"}), 400

    conn = connect()
    cur = conn.execute(
        "INSERT INTO schedules (desktop, description, kind, every_minutes, at_time, "
        "enabled, next_run_at, created_at) VALUES (?,?,?,?,?,1,?,?)",
        (desktop, description, kind, every_minutes, at_time,
         compute_next_run(kind, every_minutes, at_time), now_iso()),
    )
    conn.commit()
    row = dict(conn.execute("SELECT * FROM schedules WHERE id = ?", (cur.lastrowid,)).fetchone())
    conn.close()
    return jsonify({"ok": True, "data": row, "error": None}), 201


@app.route("/api/v1/schedules/<int:sched_id>", methods=["PATCH"])
@require_token
def api_schedule_toggle(sched_id: int):
    payload = request.get_json(silent=True) or {}
    conn = connect()
    row = conn.execute("SELECT * FROM schedules WHERE id = ?", (sched_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    enabled = 1 if str(payload.get("enabled", "1")).lower() in ("1", "true", "yes") else 0
    nxt = compute_next_run(row["kind"], row["every_minutes"], row["at_time"]) if enabled else row["next_run_at"]
    conn.execute("UPDATE schedules SET enabled = ?, next_run_at = ? WHERE id = ?", (enabled, nxt, sched_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "data": {"id": sched_id, "enabled": bool(enabled)}, "error": None})


@app.route("/api/v1/schedules/<int:sched_id>", methods=["DELETE"])
@require_token
def api_schedule_delete(sched_id: int):
    conn = connect()
    row = conn.execute("SELECT 1 FROM schedules WHERE id = ?", (sched_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    conn.execute("DELETE FROM schedules WHERE id = ?", (sched_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "data": {"id": sched_id, "removed": True}, "error": None})


def scheduler_tick() -> None:
    """Dispatch every schedule that has come due.

    Claiming is a conditional UPDATE on next_run_at: with several gunicorn
    workers each running this loop, only the one whose UPDATE matches the row
    it read gets to fire, so a schedule never double-dispatches.
    """
    now = datetime.now(timezone.utc)
    conn = connect()
    due = conn.execute(
        "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ?",
        (now.isoformat(timespec="seconds"),),
    ).fetchall()

    for row in due:
        nxt = compute_next_run(row["kind"], row["every_minutes"], row["at_time"], after=now)
        claimed = conn.execute(
            "UPDATE schedules SET next_run_at = ?, last_run_at = ?, run_count = run_count + 1 "
            "WHERE id = ? AND next_run_at = ?",
            (nxt, now.isoformat(timespec="seconds"), row["id"], row["next_run_at"]),
        )
        conn.commit()
        if claimed.rowcount != 1:
            continue  # another worker got it first
        try:
            dispatch_task(row["desktop"], row["description"])
        except Exception:  # noqa: BLE001
            pass
    conn.close()


def idle_tick() -> None:
    """Put machines nobody is watching to sleep.

    Two things count as "in use": a browser with the screen open (an
    established connection to websockify inside the desktop) and a task that
    is pending or running. Anything else has been idle since last_active_at,
    and once that is older than the timeout the machine is stopped.

    Deliberately off by default. Sleeping frees the machine's memory but ends
    its X session, so a surprise suspend costs someone their open windows —
    that has to be a choice, not a default. Machines flagged no_suspend are
    always skipped.
    """
    if IDLE_SUSPEND_MINUTES <= 0:
        return
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=IDLE_SUSPEND_MINUTES)
    conn = connect()
    busy = {r["desktop"] for r in conn.execute(
        "SELECT DISTINCT desktop FROM tasks WHERE status IN ('PENDING','RUNNING')")}
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM computers WHERE no_suspend = 0")]

    for comp in rows:
        if comp["name"] in busy:
            conn.execute("UPDATE computers SET last_active_at = ? WHERE id = ?",
                         (now_iso(), comp["id"]))
            continue
        watchers = fleet.vnc_watchers(comp["slug"])
        if watchers is None:
            continue                      # already asleep, or unreachable
        if watchers > 0:
            conn.execute("UPDATE computers SET last_active_at = ? WHERE id = ?",
                         (now_iso(), comp["id"]))
            continue
        last = comp["last_active_at"]
        if not last:
            # Never seen active — start the clock now rather than suspending a
            # machine the moment the feature is switched on.
            conn.execute("UPDATE computers SET last_active_at = ? WHERE id = ?",
                         (now_iso(), comp["id"]))
            continue
        try:
            if datetime.fromisoformat(last) > cutoff:
                continue
        except ValueError:
            continue
        try:
            fleet.suspend_computer(comp["slug"])
        except Exception:  # noqa: BLE001
            pass
    conn.commit()
    conn.close()


def claim_daily(key: str, at_time: str) -> bool:
    """True at most once per UTC day, for whichever worker gets there first.

    Same conditional-UPDATE trick the task scheduler uses: several gunicorn
    workers run this loop, and a fleet backup that fires once per worker would
    be three times the disk and three times the wall clock.
    """
    try:
        hh, mm = [int(x) for x in at_time.split(":", 1)]
    except (ValueError, AttributeError):
        return False
    now = datetime.now(timezone.utc)
    if (now.hour, now.minute) < (hh, mm):
        return False
    today = now.date().isoformat()

    conn = connect()
    try:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        if row and row["value"] >= today:
            return False
        if row:
            claimed = conn.execute(
                "UPDATE meta SET value = ? WHERE key = ? AND value = ?",
                (today, key, row["value"]))
        else:
            claimed = conn.execute(
                "INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", (key, today))
        conn.commit()
        return claimed.rowcount == 1
    finally:
        conn.close()


def maintenance_tick() -> None:
    """Daily housekeeping: back the fleet up, then trim what has aged out."""
    if backups.DAILY_AT and claim_daily("backup_daily", backups.DAILY_AT):
        for comp in list_computers():
            try:
                meta = backups.create(comp["slug"])
                audit.record("backup (scheduled)", target=comp["name"],
                             detail=f"{meta['name']} ({meta['bytes']} bytes)")
            except Exception as exc:  # noqa: BLE001
                audit.record("backup (scheduled)", target=comp["name"],
                             detail=str(exc)[:300], ok=False)

    if claim_daily("housekeeping", "03:00"):
        conn = connect()
        try:
            audit.prune(conn)
            shares.purge_expired(conn)
        finally:
            conn.close()


def scheduler_loop() -> None:
    while True:
        for tick in (scheduler_tick, idle_tick, maintenance_tick):
            try:
                tick()
            except Exception:  # noqa: BLE001
                pass
        time.sleep(20)


@app.route("/api/v1/guards")
def api_guards():
    conn = connect()
    data = guards.status(conn, budgeted_machine_count())
    conn.close()
    return jsonify({"ok": True, "data": data, "error": None})


@app.route("/partials/guards")
def partial_guards():
    conn = connect()
    data = guards.status(conn, budgeted_machine_count())
    conn.close()
    return render_template("_guards.html", g=data)


@app.route("/api/v1/maintenance/prune", methods=["POST"])
@require_token
def api_prune():
    """Reclaim the space Docker holds but no longer needs.

    Only build cache and dangling layers — never a tagged image, so a snapshot
    someone is relying on can't vanish because the disk got tight.
    """
    before = guards.disk_free_gb()
    reclaimed = 0
    try:
        reclaimed += (fleet.client().api.prune_builds() or {}).get("SpaceReclaimed", 0)
        reclaimed += (fleet.client().images.prune(filters={"dangling": True}) or {}).get(
            "SpaceReclaimed", 0)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": f"prune failed: {exc}"}), 500
    return jsonify({"ok": True, "error": None, "data": {
        "reclaimed_gb": round(reclaimed / 1e9, 2),
        "disk_free_gb_before": before,
        "disk_free_gb_after": guards.disk_free_gb(),
    }})


# ----------------------------------------------------------------- backups

def _backup_or_404(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return None, (jsonify({"ok": False, "data": None, "error": "not found"}), 404)
    return comp, None


@app.route("/api/v1/computers/<int:comp_id>/backups", methods=["GET"])
def api_backups_list(comp_id: int):
    comp, err = _backup_or_404(comp_id)
    if err:
        return err
    return jsonify({"ok": True, "data": backups.listing(comp["slug"]), "error": None})


@app.route("/api/v1/computers/<int:comp_id>/backups", methods=["POST"])
@require_token
def api_backup_create(comp_id: int):
    comp, err = _backup_or_404(comp_id)
    if err:
        return err
    ok, msg = guards.check_disk()
    if not ok:
        return jsonify({"ok": False, "data": None, "error": msg}), 507
    try:
        meta = backups.create(comp["slug"])
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": f"backup failed: {exc}"}), 500
    g.audit_detail = f"{meta['name']} ({meta['bytes']} bytes)"
    return jsonify({"ok": True, "data": meta, "error": None}), 201


@app.route("/api/v1/computers/<int:comp_id>/backups/<name>", methods=["GET"])
def api_backup_download(comp_id: int, name: str):
    comp, err = _backup_or_404(comp_id)
    if err:
        return err
    try:
        path = backups.backup_path(comp["slug"], name)
    except backups.BadBackupName as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400
    if not path.is_file():
        return jsonify({"ok": False, "data": None, "error": "no such backup"}), 404
    return Response(
        _stream_file(path), mimetype="application/gzip",
        headers={"Content-Disposition": f'attachment; filename="{comp["slug"]}-{name}"',
                 "Content-Length": str(path.stat().st_size)})


def _stream_file(path, chunk: int = 1024 * 1024):
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                return
            yield block


@app.route("/api/v1/computers/<int:comp_id>/backups/<name>", methods=["DELETE"])
@require_token
def api_backup_delete(comp_id: int, name: str):
    comp, err = _backup_or_404(comp_id)
    if err:
        return err
    try:
        removed = backups.remove(comp["slug"], name)
    except backups.BadBackupName as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400
    if not removed:
        return jsonify({"ok": False, "data": None, "error": "no such backup"}), 404
    g.audit_detail = name
    return jsonify({"ok": True, "data": {"removed": name}, "error": None})


@app.route("/api/v1/computers/<int:comp_id>/restore", methods=["POST"])
@require_token
def api_backup_restore(comp_id: int):
    """Put a backup back. The machine is stopped for the duration and
    restarted afterwards if it was running."""
    comp, err = _backup_or_404(comp_id)
    if err:
        return err
    payload = request.get_json(silent=True) or {}
    name = (payload.get("backup") or "").strip()
    source_slug = (payload.get("from") or comp["slug"]).strip()
    if not name:
        return jsonify({"ok": False, "data": None, "error": "backup is required"}), 400
    try:
        path = backups.backup_path(source_slug, name)
    except backups.BadBackupName as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400
    if not path.is_file():
        return jsonify({"ok": False, "data": None, "error": "no such backup"}), 404

    g.audit_detail = f"from {source_slug}/{name}"
    try:
        result = backups.restore(comp["slug"], path)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": f"restore failed: {exc}"}), 500
    return jsonify({"ok": True, "data": result, "error": None})


@app.route("/api/v1/computers/<int:comp_id>/restore/upload", methods=["POST"])
@require_token
def api_backup_restore_upload(comp_id: int):
    """Restore from a file the user hands us, rather than one we made.

    This is how a machine is rebuilt on a different host — and why
    `backups.sanitise` refuses members that climb out of the home directory:
    from here the archive is entirely untrusted input.
    """
    comp, err = _backup_or_404(comp_id)
    if err:
        return err
    upload = request.files.get("file")
    if not upload or not upload.filename:
        return jsonify({"ok": False, "data": None, "error": "file is required"}), 400

    tmp = Path(tempfile.gettempdir()) / f"deskswarm-restore-{comp['slug']}-{os.getpid()}.tar.gz"
    g.audit_detail = f"uploaded {upload.filename}"
    try:
        upload.save(tmp)
        result = backups.restore(comp["slug"], tmp)
    except tarfile.TarError:
        return jsonify({"ok": False, "data": None,
                        "error": "that file is not a readable .tar.gz backup"}), 400
    except OSError as exc:
        return jsonify({"ok": False, "data": None, "error": f"restore failed: {exc}"}), 500
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": f"restore failed: {exc}"}), 500
    finally:
        tmp.unlink(missing_ok=True)
    return jsonify({"ok": True, "data": result, "error": None})


@app.route("/partials/computers/<int:comp_id>/backups")
def partial_backups(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return "<div class='text-red-400 text-sm'>not found</div>", 404
    return render_template("_backups.html", comp=comp,
                           rows=backups.listing(comp["slug"]),
                           keep=backups.KEEP_PER_MACHINE,
                           daily_at=backups.DAILY_AT)


# ------------------------------------------------------------------ shares

def share_base_url() -> str:
    return request.host_url.rstrip("/")


def share_view(row: dict, comp_name: str | None = None) -> dict:
    out = dict(row)
    out.pop("token_hash", None)
    out["status"] = shares.status(row)
    out["url"] = f"{share_base_url()}/s/{row['token']}"
    if comp_name:
        out["computer"] = comp_name
    return out


@app.route("/api/v1/shares", methods=["GET"])
def api_shares_list():
    conn = connect()
    names = {c["id"]: c["name"] for c in list_computers()}
    rows = [share_view(r, names.get(r["computer_id"])) for r in shares.listing(conn)]
    conn.close()
    return jsonify({"ok": True, "data": rows, "error": None})


@app.route("/api/v1/computers/<int:comp_id>/shares", methods=["POST"])
@require_token
def api_share_create(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    payload = request.get_json(silent=True) or {}
    conn = connect()
    try:
        row = shares.create(conn, comp_id,
                            label=payload.get("label", ""),
                            mode=(payload.get("mode") or "watch").strip(),
                            hours=payload.get("hours"))
    except ValueError as exc:
        conn.close()
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400
    conn.close()
    g.audit_detail = f"{row['mode']} share '{row['label']}' until {row['expires_at']}"
    return jsonify({"ok": True, "data": share_view(row, comp["name"]), "error": None}), 201


@app.route("/api/v1/shares/<int:share_id>", methods=["DELETE"])
@require_token
def api_share_revoke(share_id: int):
    conn = connect()
    row = conn.execute("SELECT * FROM shares WHERE id = ?", (share_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    revoked = shares.revoke(conn, share_id)
    conn.close()
    g.audit_detail = f"share '{row['label']}' ({row['mode']})"
    return jsonify({"ok": True, "error": None, "data": {
        "id": share_id, "revoked": revoked,
        # Being straight about what revoking a control share does and doesn't
        # do matters more than sounding reassuring.
        "note": ("the guest's browser already holds this machine's screen "
                 "password — rotate it to retract access completely")
        if row["mode"] == "control" else None,
    }})


@app.route("/api/v1/computers/<int:comp_id>/rotate-password", methods=["POST"])
@require_token
def api_rotate_password(comp_id: int):
    """Give the machine a new screen password and restart it.

    This is the hard revoke behind a control share: anyone holding the old
    noVNC URL is out, including a guest who saved it.
    """
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    password = fleet.random_vnc_password()
    try:
        fleet.destroy_computer(comp["slug"], keep_home=True)
        fleet.create_computer(comp["slug"], comp["novnc_port"], password, image=comp["image"])
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None,
                        "error": f"failed to rotate: {exc}"}), 500
    conn = connect()
    conn.execute("UPDATE computers SET vnc_password = ? WHERE id = ?", (password, comp_id))
    conn.execute("UPDATE shares SET revoked = 1 WHERE computer_id = ? AND mode = 'control'",
                 (comp_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "data": {"id": comp_id, "rotated": True}, "error": None})


def current_share():
    """The live share behind this request, or None."""
    token = request.view_args.get("token") if request.view_args else None
    conn = connect()
    row = shares.resolve(conn, token or "")
    if row:
        shares.note_use(conn, row["id"], request.remote_addr)
        g.actor = f"share:{row['label']}"
    conn.close()
    return row


@app.route("/s/<token>")
def share_page(token: str):
    """The page a guest sees. One machine, nothing else, no dashboard."""
    row = current_share()
    if not row:
        return render_template("share_gone.html"), 404
    comp = get_computer(row["computer_id"])
    if not comp:
        return render_template("share_gone.html"), 404
    view = computer_view(comp)
    audit.record(f"GET /s/<token> ({row['mode']})", actor=f"share:{row['label']}",
                 source_ip=request.remote_addr, target=comp["name"],
                 detail="opened the share page", status=200)
    return render_template("share.html", comp=comp, view=view, share=row, token=token)


@app.route("/s/<token>/screen.png")
def share_screen(token: str):
    """The screen, served through the share rather than the machine's port —
    which is what makes a `watch` share fully revocable."""
    row = current_share()
    if not row:
        abort(404)
    comp = get_computer(row["computer_id"])
    if not comp:
        abort(404)
    if not fleet.is_running(comp["slug"]):
        abort(503)
    png = bridge_screenshot(computer_view(comp, with_state=False))
    if png is None:
        abort(503)
    return Response(png, mimetype="image/png",
                    headers={"Cache-Control": f"max-age={int(SHOT_TTL)}"})


# ------------------------------------------------------------------- audit

@app.route("/api/v1/audit")
def api_audit():
    conn = connect()
    rows, pages = audit.recent(conn, limit=PAGE_SIZE,
                               page=int(request.args.get("page", 1) or 1),
                               target=request.args.get("target") or None,
                               actor=request.args.get("actor") or None)
    conn.close()
    return jsonify({"ok": True, "data": rows, "error": None, "meta": {"pages": pages}})


@app.route("/api/v1/audit/export.csv")
def api_audit_export():
    conn = connect()
    rows = conn.execute("SELECT * FROM audit ORDER BY id DESC").fetchall()
    conn.close()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "at", "actor", "source_ip", "action", "target", "detail",
                "status", "ok"])
    for r in rows:
        w.writerow([r["id"], r["at"], r["actor"], r["source_ip"], r["action"],
                    r["target"], r["detail"], r["status"], r["ok"]])
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=audit.csv"})


@app.route("/partials/audit")
def partial_audit():
    conn = connect()
    rows, pages = audit.recent(conn, limit=PAGE_SIZE,
                               page=int(request.args.get("page", 1) or 1),
                               target=request.args.get("target") or None)
    names = [c["name"] for c in list_computers()]
    conn.close()
    return render_template("_audit.html", rows=rows, pages=pages,
                           page=int(request.args.get("page", 1) or 1),
                           target=request.args.get("target", ""), names=names)


@app.route("/api/v1/analytics")
def api_analytics():
    return jsonify({"ok": True, "data": build_analytics(), "error": None})


@app.route("/api/v1/tasks", methods=["GET"])
def api_tasks_list():
    db = get_db()
    rows = [dict(r) for r in db.execute("SELECT * FROM tasks ORDER BY id DESC LIMIT 100").fetchall()]
    for r in rows:
        r["duration_seconds"] = compute_duration_seconds(r)
    return jsonify({"ok": True, "data": rows, "error": None})


@app.route("/api/v1/tasks/export.csv")
def api_tasks_export():
    db = get_db()
    rows = db.execute("SELECT * FROM tasks ORDER BY id DESC").fetchall()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "desktop", "description", "status", "result_text", "cost_usd",
                     "duration_seconds", "error", "created_at", "updated_at"])
    for r in rows:
        d = dict(r)
        writer.writerow([d["id"], d["desktop"], d["description"], d["status"],
                         d.get("result_text") or "", d.get("cost_usd") or "",
                         compute_duration_seconds(d) or "", d.get("error") or "",
                         d["created_at"], d["updated_at"]])
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=deskswarm-tasks.csv"})


@app.route("/api/v1/tasks/<int:task_id>", methods=["GET"])
def api_task_detail(task_id: int):
    row = get_task_row(task_id)
    if not row:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    row["duration_seconds"] = compute_duration_seconds(row)
    return jsonify({"ok": True, "data": row, "error": None})


def dispatch_task(target: str, description: str) -> list[int]:
    """Queue `description` on one computer or the whole fleet.

    Shared by the tasks API and the scheduler so both behave identically.
    Raises ValueError for anything the caller should report as a 400.
    """
    conn = connect()
    for ok, msg in (guards.check_cost(conn), guards.check_breaker(conn)):
        if not ok:
            conn.close()
            raise ValueError(msg)
    conn.close()

    computers = list_computers()
    if not computers:
        raise ValueError("no computers in the fleet — add one first")

    if target == "all":
        # "Whole fleet" means every machine an agent is allowed to touch.
        # A reserved machine is one you are working on by hand, so a broadcast
        # must not grab its keyboard out from under you. Naming it explicitly
        # still works — that is a deliberate choice rather than a side effect.
        targets = [c for c in computers if not c["reserved"]]
        if not targets:
            raise ValueError("every machine is reserved — un-reserve one, or name a target")
    else:
        targets = [c for c in computers if c["name"] == target]
        if not targets:
            raise ValueError(f"unknown computer '{target}'")

    created_ids = []
    for comp in targets:
        task_id = create_task_row(comp["name"], description)
        created_ids.append(task_id)
        start_task_thread(comp, task_id, description)
    return created_ids


def start_task_thread(comp: dict, task_id: int, description: str) -> None:
    """Run one task in the background, waking the machine first if it is asleep.

    Waking takes seconds, so it belongs here rather than in dispatch_task —
    the HTTP request that queued the task should not sit and wait for a
    desktop to boot. A schedule naming a sleeping machine now works instead
    of failing against a stopped bridge.
    """
    def runner():
        try:
            if fleet.container_state(comp["slug"]).get("desktop_state") == "exited":
                wake_and_wait(comp)
        except Exception:  # noqa: BLE001
            pass
        run_task_worker(task_id, fleet.bridge_container_name(comp["slug"]), 8000, description)

    threading.Thread(target=runner, daemon=True).start()


@app.route("/api/v1/tasks", methods=["POST"])
@require_token
def api_tasks_create():
    payload = request.get_json(silent=True) or {}
    description = (payload.get("description") or "").strip()
    target = payload.get("desktop") or "all"

    if not description:
        return jsonify({"ok": False, "data": None, "error": "description is required"}), 400
    try:
        created_ids = dispatch_task(target, description)
    except ValueError as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400

    return jsonify({"ok": True, "data": {"task_ids": created_ids}, "error": None}), 201


@app.route("/api/v1/tasks/<int:task_id>/cancel", methods=["POST"])
@require_token
def api_task_cancel(task_id: int):
    row = get_task_row(task_id)
    if not row:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    if row["status"] not in ("PENDING", "RUNNING"):
        return jsonify({"ok": False, "data": None, "error": f"task is {row['status']}, cannot cancel"}), 400
    update_task_row(task_id, status="CANCELLED", current_action=None, error="cancelled by user")
    if row.get("pid"):
        try:
            os.kill(row["pid"], signal.SIGTERM)
        except ProcessLookupError:
            pass
    return jsonify({"ok": True, "data": {"id": task_id, "status": "CANCELLED"}, "error": None})


@app.route("/api/v1/tasks/<int:task_id>/retry", methods=["POST"])
@require_token
def api_task_retry(task_id: int):
    row = get_task_row(task_id)
    if not row:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    comp = get_computer_by_name(row["desktop"])
    if not comp:
        return jsonify({"ok": False, "data": None, "error": f"computer '{row['desktop']}' no longer exists"}), 400

    new_id = create_task_row(comp["name"], row["description"])
    threading.Thread(
        target=run_task_worker,
        args=(new_id, fleet.bridge_container_name(comp["slug"]), 8000, row["description"]),
        daemon=True,
    ).start()
    return jsonify({"ok": True, "data": {"task_id": new_id}, "error": None}), 201


init_db()
# Each import of this module starts the loop; tests import it many times, and
# a background thread still writing to a database whose directory is being
# torn down fails in whichever test happens to be running. Off under test.
if not os.environ.get("DESKSWARM_DISABLE_SCHEDULER"):
    threading.Thread(target=scheduler_loop, daemon=True).start()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "7000")))
