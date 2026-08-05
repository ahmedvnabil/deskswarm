import csv
import io
import json
import os
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

from flask import Flask, Response, g, jsonify, render_template, request

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("DESKSWARM_DB_PATH", str(BASE_DIR / "data" / "fleet.db")))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("DESKSWARM_DB_PATH", str(DB_PATH))

RUN_TASK_SCRIPT = str(BASE_DIR / "run_task.py")
TASK_TIMEOUT_SECONDS = int(os.environ.get("DESKSWARM_TASK_TIMEOUT", "180"))
DASHBOARD_TOKEN = os.environ.get("DASHBOARD_TOKEN")

try:
    FLEET = json.loads(os.environ["FLEET_JSON"])
except (KeyError, json.JSONDecodeError) as exc:
    raise RuntimeError(
        "FLEET_JSON env var is required — a JSON array of "
        '{"name": "...", "bridge_host": "...", "bridge_port": 8000, "novnc_url": "..."}'
    ) from exc

FLEET_BY_NAME = {d["name"]: d for d in FLEET}

app = Flask(__name__)


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
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
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
    # Additive migration for installs created before a column existed.
    existing = {row[1] for row in conn.execute("PRAGMA table_info(tasks)")}
    for col, decl in (
        ("current_action", "TEXT"),
        ("pid", "INTEGER"),
        ("started_at", "TEXT"),
    ):
        if col not in existing:
            conn.execute(f"ALTER TABLE tasks ADD COLUMN {col} {decl}")
    conn.commit()
    conn.close()


def create_task_row(desktop: str, description: str) -> int:
    conn = sqlite3.connect(DB_PATH)
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
    conn = sqlite3.connect(DB_PATH)
    fields["updated_at"] = now_iso()
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", (*fields.values(), task_id))
    conn.commit()
    conn.close()


def get_task_row(task_id: int) -> dict | None:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def run_task_worker(task_id: int, bridge_host: str, bridge_port: int, description: str):
    update_task_row(task_id, status="RUNNING", started_at=now_iso(), current_action="starting")
    try:
        proc = subprocess.Popen(
            [sys.executable, RUN_TASK_SCRIPT, str(task_id), bridge_host, str(bridge_port), description],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        update_task_row(task_id, pid=proc.pid)
        try:
            stdout, stderr = proc.communicate(timeout=TASK_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            update_task_row(
                task_id, status="FAILED", pid=None, current_action=None,
                error=f"timed out after {TASK_TIMEOUT_SECONDS}s",
            )
            return

        current = get_task_row(task_id)
        if current and current.get("status") == "CANCELLED":
            return  # already marked CANCELLED by the /cancel endpoint; don't overwrite

        last_line = None
        for line in stdout.splitlines():
            line = line.strip()
            if line.startswith("{"):
                last_line = line
        if last_line is None:
            row = get_task_row(task_id)
            if row and row.get("status") == "CANCELLED":
                return
            update_task_row(
                task_id, status="FAILED", pid=None, current_action=None,
                error=(stderr or "no output")[-2000:],
            )
            return
        payload = json.loads(last_line)
        update_task_row(
            task_id,
            status="COMPLETED",
            pid=None,
            current_action=None,
            result_text=payload.get("final_text"),
            actions=json.dumps(payload.get("actions") or []),
            cost_usd=payload.get("cost_usd"),
        )
    except Exception as exc:  # noqa: BLE001
        update_task_row(task_id, status="FAILED", pid=None, current_action=None, error=str(exc)[-2000:])


def check_bridge(desktop: dict) -> dict:
    result = {**desktop, "bridge_ok": False}
    try:
        out = subprocess.run(
            ["curl", "-sS", "-m", "3",
             f"http://{desktop['bridge_host']}:{desktop['bridge_port']}/status"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        result["bridge_ok"] = out.returncode == 0 and '"status":"ok"' in out.stdout
    except Exception:  # noqa: BLE001
        pass
    return result


def compute_duration_seconds(row: dict) -> float | None:
    start = row.get("started_at")
    end = row.get("updated_at")
    if not start or row.get("status") in ("PENDING", "RUNNING"):
        return None
    try:
        t0 = datetime.fromisoformat(start)
        t1 = datetime.fromisoformat(end)
        return round((t1 - t0).total_seconds(), 1)
    except Exception:  # noqa: BLE001
        return None


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/")
def index():
    return render_template("index.html", fleet=FLEET)


@app.route("/partials/fleet")
def partial_fleet():
    statuses = [check_bridge(d) for d in FLEET]
    return render_template("_fleet.html", statuses=statuses)


@app.route("/partials/live")
def partial_live():
    return render_template("_live.html", fleet=FLEET)


@app.route("/partials/tasks")
def partial_tasks():
    db = get_db()
    rows = [dict(r) for r in db.execute("SELECT * FROM tasks ORDER BY id DESC LIMIT 30").fetchall()]
    for r in rows:
        r["duration_seconds"] = compute_duration_seconds(r)
    return render_template("_tasks.html", tasks=rows)


@app.route("/partials/analytics")
def partial_analytics():
    return render_template("_analytics.html", analytics=build_analytics())


def build_analytics() -> dict:
    db = get_db()
    rows = [dict(r) for r in db.execute("SELECT * FROM tasks").fetchall()]

    total = len(rows)
    by_status = {"PENDING": 0, "RUNNING": 0, "COMPLETED": 0, "FAILED": 0}
    total_cost = 0.0
    durations = []
    per_desktop: dict[str, dict] = {}

    for r in rows:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
        if r.get("cost_usd"):
            total_cost += r["cost_usd"]
        dur = compute_duration_seconds(r)
        if dur is not None:
            durations.append(dur)

        pd = per_desktop.setdefault(r["desktop"], {"name": r["desktop"], "total": 0, "completed": 0, "failed": 0, "cost_usd": 0.0})
        pd["total"] += 1
        if r["status"] == "COMPLETED":
            pd["completed"] += 1
        elif r["status"] == "FAILED":
            pd["failed"] += 1
        if r.get("cost_usd"):
            pd["cost_usd"] += r["cost_usd"]

    finished = by_status["COMPLETED"] + by_status["FAILED"]
    success_rate = round(100 * by_status["COMPLETED"] / finished, 1) if finished else None
    avg_duration = round(sum(durations) / len(durations), 1) if durations else None

    daily_rows = db.execute(
        """
        SELECT date(updated_at) AS day, COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost
        FROM tasks
        WHERE status IN ('COMPLETED', 'FAILED')
        GROUP BY day
        ORDER BY day DESC
        LIMIT 14
        """
    ).fetchall()
    daily = [{"day": row["day"], "count": row["n"], "cost": round(row["cost"], 4)} for row in daily_rows][::-1]

    return {
        "total": total,
        "by_status": by_status,
        "success_rate": success_rate,
        "total_cost_usd": round(total_cost, 4),
        "avg_duration_seconds": avg_duration,
        "per_desktop": list(per_desktop.values()),
        "daily": daily,
    }


@app.route("/api/v1/fleet")
def api_fleet():
    statuses = [check_bridge(d) for d in FLEET]
    return jsonify({"ok": True, "data": statuses, "error": None})


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
        writer.writerow([
            d["id"], d["desktop"], d["description"], d["status"], d.get("result_text") or "",
            d.get("cost_usd") or "", compute_duration_seconds(d) or "", d.get("error") or "",
            d["created_at"], d["updated_at"],
        ])
    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=deskswarm-tasks.csv"},
    )


@app.route("/api/v1/tasks/<int:task_id>", methods=["GET"])
def api_task_detail(task_id: int):
    row = get_task_row(task_id)
    if not row:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    row["duration_seconds"] = compute_duration_seconds(row)
    return jsonify({"ok": True, "data": row, "error": None})


@app.route("/api/v1/tasks", methods=["POST"])
@require_token
def api_tasks_create():
    payload = request.get_json(silent=True) or request.form
    description = (payload.get("description") or "").strip()
    desktop = payload.get("desktop") or "all"

    if not description:
        return jsonify({"ok": False, "data": None, "error": "description is required"}), 400

    targets = FLEET if desktop == "all" else [d for d in FLEET if d["name"] == desktop]
    if not targets:
        return jsonify({"ok": False, "data": None, "error": f"unknown desktop '{desktop}'"}), 400

    created_ids = []
    for target in targets:
        task_id = create_task_row(target["name"], description)
        created_ids.append(task_id)
        thread = threading.Thread(
            target=run_task_worker,
            args=(task_id, target["bridge_host"], target["bridge_port"], description),
            daemon=True,
        )
        thread.start()

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
    pid = row.get("pid")
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    return jsonify({"ok": True, "data": {"id": task_id, "status": "CANCELLED"}, "error": None})


@app.route("/api/v1/tasks/<int:task_id>/retry", methods=["POST"])
@require_token
def api_task_retry(task_id: int):
    row = get_task_row(task_id)
    if not row:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404

    target = FLEET_BY_NAME.get(row["desktop"])
    if not target:
        return jsonify({"ok": False, "data": None, "error": f"desktop '{row['desktop']}' no longer in fleet"}), 400

    new_id = create_task_row(target["name"], row["description"])
    thread = threading.Thread(
        target=run_task_worker,
        args=(new_id, target["bridge_host"], target["bridge_port"], row["description"]),
        daemon=True,
    )
    thread.start()
    return jsonify({"ok": True, "data": {"task_id": new_id}, "error": None}), 201


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "7000")))
