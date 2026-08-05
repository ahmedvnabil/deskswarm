/**
 * Handing one machine to someone else, without handing over the fleet.
 *
 * A share is a link to exactly one machine, with an expiry and a revoke.
 * Two modes, and the difference between them is worth being precise about:
 *
 *   watch    the page shows the machine's screen as a refreshing still, served
 *            through the share token. Nothing about the machine is exposed:
 *            revoking is complete and immediate.
 *
 *   control  the page embeds the machine's own noVNC, so the guest gets
 *            keyboard and mouse. That means their browser is handed the
 *            machine's VNC password, and they can save the direct URL.
 *            Revoking closes the share page — it cannot reach into their
 *            browser and take back what they already have. Rotating the
 *            machine's screen password is what actually retracts it.
 *
 * Tokens are looked up by their hash and then confirmed with a constant-time
 * comparison, so a timing difference doesn't leak them one character at a time.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb, all, one, run } from "./db";
import { envInt, nowIso, parseIso } from "./settings";

export const MODES = ["watch", "control"] as const;
export const DEFAULT_HOURS = envInt("DESKSWARM_SHARE_DEFAULT_HOURS", 24);
export const MAX_HOURS = envInt("DESKSWARM_SHARE_MAX_HOURS", 720); // 30 days

export interface ShareRow {
  id: number;
  computer_id: number;
  token: string;
  token_hash: string;
  label: string;
  mode: string;
  expires_at: string;
  revoked: number;
  uses: number;
  last_used_at: string | null;
  last_used_ip: string | null;
  created_at: string;
  status?: string;
}

export function init(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      computer_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'watch',
      expires_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      uses INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      last_used_ip TEXT,
      created_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS shares_hash ON shares (token_hash)");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time equality that tolerates unequal lengths, which
 *  timingSafeEqual itself throws on. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export function create(
  computerId: number,
  label: string,
  mode = "watch",
  hours?: number | null,
): ShareRow {
  if (!(MODES as readonly string[]).includes(mode)) {
    throw new ValidationError(`mode must be one of ${MODES.join(", ")}`);
  }
  const h = hours === undefined || hours === null ? DEFAULT_HOURS : Number(hours);
  if (!Number.isFinite(h) || h < 1 || h > MAX_HOURS) {
    throw new ValidationError(`expiry must be between 1 and ${MAX_HOURS} hours`);
  }
  const cleanLabel = (label || "").trim() || "guest";

  const token = newToken();
  const expires = new Date(Date.now() + h * 3600_000);
  run(
    "INSERT INTO shares (computer_id, token, token_hash, label, mode, " +
      "expires_at, created_at) VALUES (?,?,?,?,?,?,?)",
    computerId,
    token,
    hashToken(token),
    cleanLabel,
    mode,
    nowIso(expires),
    nowIso(),
  );
  return one<ShareRow>("SELECT * FROM shares WHERE token = ?", token)!;
}

/** A user-facing message the route layer turns into a 400. */
export class ValidationError extends Error {}

export function resolve(token: string): ShareRow | null {
  if (!token) return null;
  const row = one<ShareRow>(
    "SELECT * FROM shares WHERE token_hash = ?",
    hashToken(token),
  );
  if (!row) return null;
  if (!sameSecret(row.token, token)) return null;
  if (row.revoked) return null;
  const expires = parseIso(row.expires_at);
  if (!expires || expires.getTime() <= Date.now()) return null;
  return row;
}

export function noteUse(shareId: number, ip: string | null): void {
  run(
    "UPDATE shares SET uses = uses + 1, last_used_at = ?, last_used_ip = ? WHERE id = ?",
    nowIso(),
    ip,
    shareId,
  );
}

export function revoke(shareId: number): boolean {
  return (
    run("UPDATE shares SET revoked = 1 WHERE id = ? AND revoked = 0", shareId)
      .changes === 1
  );
}

export function status(row: ShareRow): string {
  if (row.revoked) return "revoked";
  const expires = parseIso(row.expires_at);
  if (!expires || expires.getTime() <= Date.now()) return "expired";
  return "live";
}

export function listing(computerId?: number | null): ShareRow[] {
  const rows =
    computerId === undefined || computerId === null
      ? all<ShareRow>("SELECT * FROM shares ORDER BY id DESC")
      : all<ShareRow>(
          "SELECT * FROM shares WHERE computer_id = ? ORDER BY id DESC",
          computerId,
        );
  return rows.map((r) => ({ ...r, status: status(r) }));
}

/** Forget shares that stopped working a while ago, so the table doesn't
 *  become an ever-growing list of dead links. */
export function purgeExpired(keepDays = 30): number {
  const cutoff = nowIso(new Date(Date.now() - keepDays * 86400_000));
  return run("DELETE FROM shares WHERE expires_at < ?", cutoff).changes;
}
