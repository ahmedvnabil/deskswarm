"""Tables, and the additive migrations that carry an existing database forward."""

import audit
import shares
from db import connect


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
