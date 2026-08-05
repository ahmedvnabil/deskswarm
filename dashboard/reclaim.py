"""
Fail tasks whose runner died with a previous dashboard process.

A task is driven by a thread plus a subprocess inside the dashboard process.
If the container restarts mid-task, nothing survives to finish it, but the row
stays RUNNING for ever: the machine shows busy on the wall, "0 running" is
wrong, and the task never resolves.

This runs once per container start, *before* gunicorn forks its workers. Doing
it at app import time instead would run it in every worker, so a single worker
respawning later would wrongly fail tasks its sibling was still running.
"""

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(os.environ.get("DESKSWARM_DB_PATH", str(Path(__file__).resolve().parent / "data" / "fleet.db")))


def main() -> None:
    if not DB_PATH.exists():
        return
    conn = sqlite3.connect(DB_PATH, timeout=10)
    try:
        conn.execute("SELECT 1 FROM tasks LIMIT 1")
    except sqlite3.OperationalError:
        conn.close()
        return  # first boot, no schema yet
    cur = conn.execute(
        "UPDATE tasks SET status = 'FAILED', pid = NULL, current_action = NULL, "
        "error = 'interrupted — the dashboard restarted while this task was running', "
        "updated_at = ? WHERE status IN ('PENDING', 'RUNNING')",
        (datetime.now(timezone.utc).isoformat(timespec="seconds"),),
    )
    conn.commit()
    if cur.rowcount:
        print(f"[reclaim] failed {cur.rowcount} task(s) orphaned by a restart", flush=True)
    conn.close()


if __name__ == "__main__":
    main()
