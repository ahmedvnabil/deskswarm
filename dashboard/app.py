import json
import os
import sqlite3
import subprocess
import sys
import threading
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("DESKSWARM_DB_PATH", str(BASE_DIR / "data" / "fleet.db")))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

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
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            desktop TEXT NOT NULL,
            description TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'PENDING',
            result_text TEXT,
            actions TEXT,
            cost_usd REAL,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
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


def run_task_worker(task_id: int, bridge_host: str, bridge_port: int, description: str):
    update_task_row(task_id, status="RUNNING")
    try:
        proc = subprocess.run(
            [sys.executable, RUN_TASK_SCRIPT, bridge_host, str(bridge_port), description],
            capture_output=True,
            text=True,
            timeout=TASK_TIMEOUT_SECONDS,
        )
        last_line = None
        for line in proc.stdout.splitlines():
            line = line.strip()
            if line.startswith("{"):
                last_line = line
        if last_line is None:
            update_task_row(
                task_id,
                status="FAILED",
                error=(proc.stderr or "no output")[-2000:],
            )
            return
        payload = json.loads(last_line)
        update_task_row(
            task_id,
            status="COMPLETED",
            result_text=payload.get("final_text"),
            actions=json.dumps(payload.get("actions") or []),
            cost_usd=payload.get("cost_usd"),
        )
    except subprocess.TimeoutExpired:
        update_task_row(task_id, status="FAILED", error=f"timed out after {TASK_TIMEOUT_SECONDS}s")
    except Exception as exc:  # noqa: BLE001
        update_task_row(task_id, status="FAILED", error=str(exc)[-2000:])


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


@app.route("/partials/tasks")
def partial_tasks():
    db = get_db()
    rows = db.execute("SELECT * FROM tasks ORDER BY id DESC LIMIT 30").fetchall()
    return render_template("_tasks.html", tasks=rows)


@app.route("/api/v1/fleet")
def api_fleet():
    statuses = [check_bridge(d) for d in FLEET]
    return jsonify({"ok": True, "data": statuses, "error": None})


@app.route("/api/v1/tasks", methods=["GET"])
def api_tasks_list():
    db = get_db()
    rows = db.execute("SELECT * FROM tasks ORDER BY id DESC LIMIT 100").fetchall()
    return jsonify({"ok": True, "data": [dict(r) for r in rows], "error": None})


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


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "7000")))
