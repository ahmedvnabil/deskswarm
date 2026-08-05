"""Task rows, the worker that runs one, dispatch, and the analytics over them."""

import json
import subprocess
import sys
import threading
from datetime import datetime

import fleet
import guards
from db import connect, get_db
from machines import list_computers, now_iso, wake_and_wait
from settings import MAX_CONCURRENT_TASKS, RUN_TASK_SCRIPT, TASK_TIMEOUT_SECONDS

# A task costs a subprocess plus an agent session. Without a ceiling, "run on
# the whole fleet" across a large fleet would start them all at once.
_task_slots = threading.BoundedSemaphore(MAX_CONCURRENT_TASKS)


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
