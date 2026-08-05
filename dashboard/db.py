"""One place that knows where the database is.

The feature modules need connections of their own — they run in the scheduler
thread rather than a request — and importing app.py to borrow its `connect`
would be circular. The path is read lazily on every call so that app.py can
still settle `DESKSWARM_DB_PATH` at import time.
"""

import os
import sqlite3
from pathlib import Path


def db_path() -> Path:
    return Path(os.environ["DESKSWARM_DB_PATH"])


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(db_path(), timeout=10)
    conn.row_factory = sqlite3.Row
    return conn
