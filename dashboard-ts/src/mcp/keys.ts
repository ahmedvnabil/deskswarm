/**
 * A key is the whole of an outside client's authority: one machine, until it
 * expires or is revoked.
 *
 * This is deliberately the same design as a share token, for the same reason —
 * the thing you hand out should not be able to reach anything you did not name.
 * A share hands a person a screen; a key hands a program a computer. Neither
 * can be widened after the fact: the machine is fixed at issue, so a client
 * that gets creative still only ever talks to the machine it was given.
 *
 * Tokens are looked up by their hash and then confirmed with a constant-time
 * comparison, so a timing difference doesn't leak them one character at a time.
 *
 * The token is stored alongside its hash rather than only hashed, which is
 * worth being honest about: it means anyone with the database file has every
 * key. That is already true of `computers.vnc_password` — the screen password
 * has to be readable to be shown to you — and a key you cannot show again is a
 * key people write down somewhere worse. Revoking is the control that matters,
 * and it is one click.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb, all, one, run } from "./../db";
import { envInt, nowIso, parseIso } from "./../settings";

export const DEFAULT_DAYS = envInt("DESKSWARM_MCP_KEY_DEFAULT_DAYS", 30);
export const MAX_DAYS = envInt("DESKSWARM_MCP_KEY_MAX_DAYS", 365);

export interface KeyRow {
  id: number;
  computer_id: number;
  token: string;
  token_hash: string;
  label: string;
  expires_at: string | null;
  revoked: number;
  calls: number;
  last_used_at: string | null;
  last_used_ip: string | null;
  last_tool: string | null;
  created_at: string;
  status?: string;
}

/** A user-facing problem the route layer turns into a 400. */
export class ValidationError extends Error {}

export function init(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      computer_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      expires_at TEXT,
      revoked INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      last_used_ip TEXT,
      last_tool TEXT,
      created_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS mcp_keys_hash ON mcp_keys (token_hash)");
  db.exec("CREATE INDEX IF NOT EXISTS mcp_keys_computer ON mcp_keys (computer_id)");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Prefixed so a leaked key is recognisable for what it is — in a log, a paste
 *  or a secret scanner — rather than looking like any other opaque blob. */
export function newToken(): string {
  return `dsk_${randomBytes(32).toString("base64url")}`;
}

/** Constant-time equality that tolerates unequal lengths, which
 *  timingSafeEqual itself throws on. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * Issue a key for one machine.
 *
 * `days` of 0 means no expiry, which is a real thing to want — a key wired
 * into a config file that should keep working — and is why the column is
 * nullable rather than defaulted to a far-future date.
 */
export function create(
  computerId: number,
  label: string,
  days?: number | null,
): KeyRow {
  const d = days === undefined || days === null ? DEFAULT_DAYS : Number(days);
  if (!Number.isFinite(d) || d < 0 || d > MAX_DAYS) {
    throw new ValidationError(`expiry must be between 0 and ${MAX_DAYS} days`);
  }
  const cleanLabel = (label || "").trim().slice(0, 80) || "client";

  const token = newToken();
  const expires = d === 0 ? null : nowIso(new Date(Date.now() + d * 86400_000));
  run(
    "INSERT INTO mcp_keys (computer_id, token, token_hash, label, expires_at, created_at) " +
      "VALUES (?,?,?,?,?,?)",
    computerId,
    token,
    hashToken(token),
    cleanLabel,
    expires,
    nowIso(),
  );
  return one<KeyRow>("SELECT * FROM mcp_keys WHERE token = ?", token)!;
}

/**
 * The key behind a bearer token, or null.
 *
 * Null covers every reason equally — unknown, revoked, expired — because a
 * caller that can tell the difference can also enumerate which of its guesses
 * were once real keys.
 */
export function resolve(token: string): KeyRow | null {
  if (!token) return null;
  const row = one<KeyRow>(
    "SELECT * FROM mcp_keys WHERE token_hash = ?",
    hashToken(token),
  );
  if (!row) return null;
  if (!sameSecret(row.token, token)) return null;
  if (row.revoked) return null;
  if (row.expires_at) {
    const expires = parseIso(row.expires_at);
    if (!expires || expires.getTime() <= Date.now()) return null;
  }
  return row;
}

/** Record that a key was used, and for what. Cheap enough to do per call, and
 *  it is what makes a stale key obvious in the UI. */
export function noteUse(keyId: number, tool: string, ip: string | null): void {
  run(
    "UPDATE mcp_keys SET calls = calls + 1, last_used_at = ?, last_used_ip = ?, " +
      "last_tool = ? WHERE id = ?",
    nowIso(),
    ip,
    tool.slice(0, 60),
    keyId,
  );
}

export function revoke(keyId: number): boolean {
  return (
    run("UPDATE mcp_keys SET revoked = 1 WHERE id = ? AND revoked = 0", keyId)
      .changes === 1
  );
}

export function status(row: KeyRow): string {
  if (row.revoked) return "revoked";
  if (row.expires_at) {
    const expires = parseIso(row.expires_at);
    if (!expires || expires.getTime() <= Date.now()) return "expired";
  }
  return "live";
}

export function listing(computerId?: number | null): KeyRow[] {
  const rows =
    computerId === undefined || computerId === null
      ? all<KeyRow>("SELECT * FROM mcp_keys ORDER BY id DESC")
      : all<KeyRow>(
          "SELECT * FROM mcp_keys WHERE computer_id = ? ORDER BY id DESC",
          computerId,
        );
  return rows.map((r) => ({ ...r, status: status(r) }));
}

/**
 * How many live keys each machine has, keyed by computer_id.
 *
 * One query for the whole fleet rather than one per tile: the wall re-renders
 * every five seconds, and a machine with no key is worth showing precisely
 * because nothing can reach it — so this is read on every one of those.
 */
export function liveCountByComputer(): Record<number, number> {
  const rows = all<{ computer_id: number; n: number }>(
    "SELECT computer_id, COUNT(*) AS n FROM mcp_keys " +
      "WHERE revoked = 0 AND (expires_at IS NULL OR expires_at > ?) " +
      "GROUP BY computer_id",
    nowIso(),
  );
  return Object.fromEntries(rows.map((r) => [r.computer_id, r.n]));
}

/** Keys issued against a machine that no longer exists are dead weight, and
 *  deleting a machine should not leave its authority lying in the table. */
export function deleteForComputer(computerId: number): number {
  return run("DELETE FROM mcp_keys WHERE computer_id = ?", computerId).changes;
}

/** Forget keys that stopped working a while ago, so the table doesn't become
 *  an ever-growing list of dead credentials. */
export function purgeExpired(keepDays = 30): number {
  const cutoff = nowIso(new Date(Date.now() - keepDays * 86400_000));
  return run(
    "DELETE FROM mcp_keys WHERE expires_at IS NOT NULL AND expires_at < ?",
    cutoff,
  ).changes;
}
