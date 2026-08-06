/**
 * Tables, and the additive migrations that carry an existing database forward.
 *
 * The column checks are the same PRAGMA-then-ALTER the Python version used,
 * but they are safe here in a way they were not there: gunicorn ran two worker
 * processes that both executed this at import, both read the column list
 * before either committed, and the loser died with "duplicate column name".
 * One process, one migration.
 */

import { getDb, all } from "./db";
import * as audit from "./audit";
import * as auth from "./auth";
import * as shares from "./shares";

function columns(table: string): Set<string> {
  return new Set(
    all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name),
  );
}

export function initDb(): void {
  const db = getDb();

  db.exec(`
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
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS computers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      novnc_port INTEGER NOT NULL,
      vnc_password TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      image TEXT NOT NULL,
      source TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
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
  `);

  const comp = columns("computers");
  if (!comp.has("image")) {
    db.exec("ALTER TABLE computers ADD COLUMN image TEXT");
  }
  if (!comp.has("reserved")) {
    // A reserved machine is yours to drive by hand; agents keep off it.
    db.exec(
      "ALTER TABLE computers ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!comp.has("last_active_at")) {
    // Last time a browser had the screen open or a task was running on it.
    db.exec("ALTER TABLE computers ADD COLUMN last_active_at TEXT");
  }
  if (!comp.has("no_suspend")) {
    // Machines the idle sweeper must leave alone whatever the timeout says.
    db.exec(
      "ALTER TABLE computers ADD COLUMN no_suspend INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!comp.has("provider")) {
    // Which backend owns this machine. Existing rows predate the column and
    // are all Docker, which is what the default says.
    db.exec(
      "ALTER TABLE computers ADD COLUMN provider TEXT NOT NULL DEFAULT 'docker'",
    );
  }

  audit.init();
  auth.init();
  shares.init();

  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );

  const snap = columns("snapshots");
  if (!snap.has("provider")) {
    // A snapshot is an image in one backend's store, so deleting it has to go
    // back to the same one.
    db.exec(
      "ALTER TABLE snapshots ADD COLUMN provider TEXT NOT NULL DEFAULT 'docker'",
    );
  }

  const task = columns("tasks");
  for (const [col, decl] of [
    ["current_action", "TEXT"],
    ["pid", "INTEGER"],
    ["started_at", "TEXT"],
  ] as const) {
    if (!task.has(col)) {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${decl}`);
    }
  }
}
