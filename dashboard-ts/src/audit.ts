/**
 * Who did what, and from where.
 *
 * Once a machine can be shared with someone else, "the dashboard did it" stops
 * being a useful answer. Every state-changing request lands here, recorded by
 * a single middleware rather than by calls sprinkled through the handlers — a
 * log you have to remember to write is a log with holes in it, and the holes
 * are always in the endpoints that matter.
 *
 * Contents are deliberately not recorded: the command a shell ran is, because
 * that is the point of the log, but clipboard text and file bodies are only
 * ever counted. An audit trail that quietly archives everything anyone typed
 * is its own kind of problem.
 */

import { getDb, all, one, run } from "./db";
import { envInt, nowIso } from "./settings";

export const RETENTION_DAYS = envInt("DESKSWARM_AUDIT_RETENTION_DAYS", 90);

// Routes worth no line: polling and health checks would drown everything else.
const IGNORED_PATH_PREFIXES = ["/partials/", "/health", "/static/"];

export interface AuditRow {
  id: number;
  at: string;
  actor: string;
  source_ip: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  status: number | null;
  ok: number;
}

export function init(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,          -- 'dashboard' or 'share:<label>'
      source_ip TEXT,
      action TEXT NOT NULL,         -- 'POST /api/v1/computers/3/exec'
      target TEXT,                  -- machine name where known
      detail TEXT,                  -- short, never file or clipboard bodies
      status INTEGER,               -- HTTP status
      ok INTEGER NOT NULL DEFAULT 1
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS audit_at ON audit (at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS audit_target ON audit (target)");
}

export function record(
  action: string,
  opts: {
    actor?: string;
    source_ip?: string | null;
    target?: string | null;
    detail?: unknown;
    status?: number | null;
    ok?: boolean;
  } = {},
): void {
  let detail = opts.detail;
  if (detail !== undefined && detail !== null && typeof detail !== "string") {
    detail = JSON.stringify(detail).slice(0, 2000);
  }
  const text = ((detail as string) || "").slice(0, 2000) || null;
  run(
    "INSERT INTO audit (at, actor, source_ip, action, target, detail, status, ok) " +
      "VALUES (?,?,?,?,?,?,?,?)",
    nowIso(),
    opts.actor ?? "dashboard",
    opts.source_ip ?? null,
    action,
    opts.target ?? null,
    text,
    opts.status ?? null,
    opts.ok === false ? 0 : 1,
  );
}

export function shouldRecord(method: string, path: string): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return false;
  return !IGNORED_PATH_PREFIXES.some((p) => path.startsWith(p));
}

/** Drop entries past the retention window. An audit log that grows without
 *  limit eventually becomes the reason the disk filled. */
export function prune(): number {
  if (RETENTION_DAYS <= 0) return 0;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000);
  return run("DELETE FROM audit WHERE at < ?", nowIso(cutoff)).changes;
}

export function recent(
  limit = 100,
  page = 1,
  target?: string | null,
  actor?: string | null,
): { rows: AuditRow[]; pages: number } {
  const where: string[] = [];
  const params: any[] = [];
  if (target) {
    where.push("target = ?");
    params.push(target);
  }
  if (actor) {
    where.push("actor LIKE ?");
    params.push(actor + "%");
  }
  const clause = where.length ? " WHERE " + where.join(" AND ") : "";

  const total =
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM audit${clause}`, ...params)
      ?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));
  const wanted = Math.min(Math.max(1, page), pages);
  const rows = all<AuditRow>(
    `SELECT * FROM audit${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    (wanted - 1) * limit,
  );
  return { rows, pages };
}
