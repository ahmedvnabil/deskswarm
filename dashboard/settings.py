"""Every environment-derived setting, in one place.

Spread across the modules that happen to use them, these become impossible to
survey — and the answer to "what can I configure?" should not require reading
the whole codebase.
"""

import os
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent


DB_PATH = Path(os.environ.get("DESKSWARM_DB_PATH", str(BASE_DIR / "data" / "fleet.db")))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
# Settled once, here, because db.py reads it on every connect and the worker
# subprocess inherits it.
os.environ.setdefault("DESKSWARM_DB_PATH", str(DB_PATH))


RUN_TASK_SCRIPT = str(BASE_DIR / "run_task.py")


TASK_TIMEOUT_SECONDS = int(os.environ.get("DESKSWARM_TASK_TIMEOUT", "300"))


DASHBOARD_TOKEN = os.environ.get("DASHBOARD_TOKEN")


MAX_BULK_CREATE = int(os.environ.get("DESKSWARM_MAX_BULK_CREATE", "25"))


PAGE_SIZE = int(os.environ.get("DESKSWARM_PAGE_SIZE", "25"))


# A task costs a subprocess plus an agent session. Without a ceiling, "run on
# the whole fleet" across a large fleet would start them all at once.
MAX_CONCURRENT_TASKS = int(os.environ.get("DESKSWARM_MAX_CONCURRENT_TASKS", "8"))


IDLE_SUSPEND_MINUTES = int(os.environ.get("DESKSWARM_IDLE_SUSPEND_MINUTES", "0"))


WAKE_TIMEOUT_SECONDS = float(os.environ.get("DESKSWARM_WAKE_TIMEOUT", "45"))


MAX_CLIPBOARD_KB = int(os.environ.get("DESKSWARM_MAX_CLIPBOARD_KB", "256"))


MAX_UPLOAD_MB = int(os.environ.get("DESKSWARM_MAX_UPLOAD_MB", "64"))


SHOT_TTL = float(os.environ.get("DESKSWARM_SHOT_TTL", "3"))
