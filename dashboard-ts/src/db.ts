/**
 * One place that knows where the database is.
 *
 * The Flask version opened a connection per call because it ran in several
 * gunicorn worker processes and a shared handle would have crossed a fork.
 * A single Bun process has no such problem, so this is one handle for the
 * whole app — which also removes the cross-process migration race the Python
 * version had, where two workers ran the same ALTER TABLE at once.
 *
 * The path is read lazily on first use so tests can point it somewhere else
 * before anything touches it.
 */

import { Database } from "bun:sqlite";
import { DB_PATH } from "./settings";

let handle: Database | null = null;

export function getDb(): Database {
  if (handle === null) {
    handle = new Database(process.env.DESKSWARM_DB_PATH || DB_PATH, {
      create: true,
    });
    handle.exec("PRAGMA journal_mode = WAL");
    // The Python version passed timeout=10 to every connect(); this is the
    // same thing — wait for a writer rather than failing the request.
    handle.exec("PRAGMA busy_timeout = 10000");
  }
  return handle;
}

/** Close the handle. Tests call this between temporary databases. */
export function closeDb(): void {
  handle?.close();
  handle = null;
}

export type Row = Record<string, any>;

export function all<T = Row>(sql: string, ...params: any[]): T[] {
  return getDb().query(sql).all(...(params as any)) as T[];
}

export function one<T = Row>(sql: string, ...params: any[]): T | null {
  return (getDb().query(sql).get(...(params as any)) as T) ?? null;
}

/** Returns the row count the statement touched, like sqlite3's `rowcount`. */
export function run(sql: string, ...params: any[]): {
  changes: number;
  lastInsertRowid: number;
} {
  const res = getDb().run(sql, params as any);
  return {
    changes: res.changes,
    lastInsertRowid: Number(res.lastInsertRowid),
  };
}
