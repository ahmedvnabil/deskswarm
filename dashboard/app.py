import csv
import io
import json
import os
import signal
import sqlite3
import subprocess
import sys
import threading
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

from flask import Flask, Response, g, jsonify, render_template, request

import fleet

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("DESKSWARM_DB_PATH", str(BASE_DIR / "data" / "fleet.db")))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("DESKSWARM_DB_PATH", str(DB_PATH))

RUN_TASK_SCRIPT = str(BASE_DIR / "run_task.py")
TASK_TIMEOUT_SECONDS = int(os.environ.get("DESKSWARM_TASK_TIMEOUT", "300"))
DASHBOARD_TOKEN = os.environ.get("DASHBOARD_TOKEN")

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


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


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
    return dict(row) if row else None


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
        "novnc_url": fleet.novnc_url(comp["novnc_port"]),
        "bridge_host": fleet.bridge_container_name(comp["slug"]),
        "bridge_port": 8000,
        "created_at": comp["created_at"],
        "bridge_ok": False,
    }
    if with_state:
        try:
            view.update(fleet.container_state(comp["slug"]))
        except Exception as exc:  # noqa: BLE001
            view["error"] = str(exc)
        view["bridge_ok"] = check_bridge(view)
    return view


def check_bridge(view: dict) -> bool:
    try:
        out = subprocess.run(
            ["curl", "-sS", "-m", "3", f"http://{view['bridge_host']}:{view['bridge_port']}/status"],
            capture_output=True, text=True, timeout=5,
        )
        return out.returncode == 0 and '"status":"ok"' in out.stdout
    except Exception:  # noqa: BLE001
        return False


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
        "per_desktop": list(per_desktop.values()),
        "daily": [{"day": r["day"], "count": r["n"], "cost": round(r["cost"], 4)} for r in daily_rows][::-1],
    }


# ------------------------------------------------------------------- routes

@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/")
def index():
    return render_template("index.html", computers=list_computers())


@app.route("/partials/fleet")
def partial_fleet():
    return render_template("_fleet.html", computers=[computer_view(c) for c in list_computers()])


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


@app.route("/api/v1/computers", methods=["GET"])
def api_computers_list():
    return jsonify({"ok": True, "data": [computer_view(c) for c in list_computers()], "error": None})


@app.route("/api/v1/computers", methods=["POST"])
@require_token
def api_computers_create():
    payload = request.get_json(silent=True) or request.form
    name = (payload.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "data": None, "error": "name is required"}), 400

    slug = fleet.slugify(name)
    conn = connect()
    clash = conn.execute("SELECT 1 FROM computers WHERE name = ? OR slug = ?", (name, slug)).fetchone()
    if clash:
        conn.close()
        return jsonify({"ok": False, "data": None, "error": f"'{name}' already exists"}), 409

    reserved = {r["novnc_port"] for r in conn.execute("SELECT novnc_port FROM computers")}
    port = fleet.next_novnc_port(reserved)
    password = fleet.random_vnc_password()

    try:
        fleet.create_computer(slug, port, password)
    except Exception as exc:  # noqa: BLE001
        conn.close()
        return jsonify({"ok": False, "data": None, "error": f"failed to start containers: {exc}"}), 500

    conn.execute(
        "INSERT INTO computers (name, slug, novnc_port, vnc_password, created_at) VALUES (?,?,?,?,?)",
        (name, slug, port, password, now_iso()),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM computers WHERE slug = ?", (slug,)).fetchone()
    conn.close()
    return jsonify({"ok": True, "data": computer_view(dict(row), with_state=False), "error": None}), 201


@app.route("/api/v1/computers/<int:comp_id>", methods=["PATCH"])
@require_token
def api_computers_rename(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    payload = request.get_json(silent=True) or request.form
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
    return render_template("_inventory.html", comp=comp, inv=inv)


@app.route("/api/v1/computers/<int:comp_id>/exec", methods=["POST"])
@require_token
def api_computers_exec(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    payload = request.get_json(silent=True) or request.form
    command = (payload.get("command") or "").strip()
    if not command:
        return jsonify({"ok": False, "data": None, "error": "command is required"}), 400
    try:
        result = fleet.exec_in_desktop(comp["slug"], command)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 500
    return jsonify({"ok": True, "data": result, "error": None})


@app.route("/api/v1/fleet")
def api_fleet():
    return jsonify({"ok": True, "data": [computer_view(c) for c in list_computers()], "error": None})


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


@app.route("/api/v1/tasks", methods=["POST"])
@require_token
def api_tasks_create():
    payload = request.get_json(silent=True) or request.form
    description = (payload.get("description") or "").strip()
    target = payload.get("desktop") or "all"

    if not description:
        return jsonify({"ok": False, "data": None, "error": "description is required"}), 400

    computers = list_computers()
    if not computers:
        return jsonify({"ok": False, "data": None, "error": "no computers in the fleet — add one first"}), 400

    targets = computers if target == "all" else [c for c in computers if c["name"] == target]
    if not targets:
        return jsonify({"ok": False, "data": None, "error": f"unknown computer '{target}'"}), 400

    created_ids = []
    for comp in targets:
        task_id = create_task_row(comp["name"], description)
        created_ids.append(task_id)
        threading.Thread(
            target=run_task_worker,
            args=(task_id, fleet.bridge_container_name(comp["slug"]), 8000, description),
            daemon=True,
        ).start()

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

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "7000")))
