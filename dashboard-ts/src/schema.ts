/**
 * Tables, and the migrations that carry an existing database forward.
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
import * as keys from "./mcp/keys";
import { initProxmox } from "./connections/proxmox";
import { initConnections } from "./connections/netbird";
import { initTunnels } from "./cloudflare/tunnels";
import { initCloudflare } from "./cloudflare/control";
import { initServers } from "./servers";
import { initAgents } from "./agents/store";

function columns(table: string): Set<string> {
  return new Set(
    all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name),
  );
}

/**
 * Remove the obsolete Python task/schedule schema.
 *
 * The new managed Agents implementation uses agent_* tables and never reads
 * or replays these legacy prompts and schedules.
 *
 * Idempotent, so a fresh database and an upgraded one end up identical.
 */
function dropAgentTables(): void {
  const db = getDb();
  db.exec("DROP TABLE IF EXISTS tasks");
  db.exec("DROP TABLE IF EXISTS schedules");
}

export function initDb(): void {
  const db = getDb();

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

  const comp = columns("computers");
  if (!comp.has("image")) {
    db.exec("ALTER TABLE computers ADD COLUMN image TEXT");
  }
  if (!comp.has("reserved")) {
    // A reserved machine is yours to drive by hand; MCP keys for it are
    // refused, so a client that has one cannot take the keyboard from you.
    db.exec(
      "ALTER TABLE computers ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!comp.has("last_active_at")) {
    // Last time a browser had the screen open or an MCP client touched it.
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
  keys.init();
  initAgents();
  initServers();
  initCloudflare();
  initTunnels();
  initConnections();
  initProxmox();

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

  dropAgentTables();
}
