import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

DASHBOARD = Path(__file__).resolve().parents[1] / "dashboard"


def test_orphaned_tasks_are_failed_on_restart(tmp_path):
    """A task is driven by a thread + subprocess inside the dashboard. If the
    container restarts mid-task nothing finishes it, and the row used to stay
    RUNNING for ever — the machine showed busy on the wall and the task never
    resolved. Reproduced against a real deployment before this was added."""
    db = tmp_path / "fleet.db"
    conn = sqlite3.connect(db)
    conn.execute("""CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, desktop TEXT, description TEXT,
        status TEXT, current_action TEXT, result_text TEXT, actions TEXT,
        cost_usd REAL, error TEXT, pid INTEGER, started_at TEXT,
        created_at TEXT, updated_at TEXT)""")
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn.executemany(
        "INSERT INTO tasks (desktop, description, status, pid, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?)",
        [("m1", "a", "RUNNING", 8214, ts, ts),
         ("m2", "b", "PENDING", None, ts, ts),
         ("m3", "c", "COMPLETED", None, ts, ts)],
    )
    conn.commit()
    conn.close()

    subprocess.run([sys.executable, "reclaim.py"], cwd=DASHBOARD, check=True,
                   env={"DESKSWARM_DB_PATH": str(db), "PATH": "/usr/bin:/bin"})

    conn = sqlite3.connect(db)
    rows = {d: (s, e) for d, s, e in
            conn.execute("SELECT desktop, status, error FROM tasks")}
    conn.close()

    assert rows["m1"][0] == "FAILED" and "restarted" in rows["m1"][1]
    assert rows["m2"][0] == "FAILED"
    assert rows["m3"][0] == "COMPLETED"   # finished work is untouched


def test_reclaim_is_safe_on_a_fresh_install(tmp_path):
    subprocess.run([sys.executable, "reclaim.py"], cwd=DASHBOARD, check=True,
                   env={"DESKSWARM_DB_PATH": str(tmp_path / "missing.db"),
                        "PATH": "/usr/bin:/bin"})
