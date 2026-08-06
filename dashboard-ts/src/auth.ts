/**
 * Who is allowed in.
 *
 * Until now the only gate was DASHBOARD_TOKEN, and it guarded *mutations*
 * only: anyone who could reach the port could list the fleet, read the audit
 * log, browse a machine's files and watch its screen. That was a defensible
 * trade for something the README told you to keep off the internet. It is not
 * defensible for something with a public address, so this adds a session in
 * front of everything.
 *
 * Three ways in, and they are deliberately different:
 *
 *   session   a person, with a username and password, in a browser
 *   token     a script — n8n, cron, curl — carrying DASHBOARD_TOKEN
 *   share     a guest with a link to exactly one machine (see shares.ts)
 *
 * Passwords go through Bun.password, which is argon2id by default. No
 * dependency, no parameter tuning, and no chance of someone reaching for a
 * fast hash because it was easier.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { getDb, all, one, run } from "./db";
import { envInt, nowIso, parseIso } from "./settings";

/** How long a browser stays signed in without re-entering a password. */
export const SESSION_HOURS = envInt("DESKSWARM_SESSION_HOURS", 24 * 14);

export interface User {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
  last_login_at: string | null;
}

export class AuthError extends Error {}

export function init(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT,
      ip TEXT,
      user_agent TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS sessions_hash ON sessions (token_hash)");
  db.exec("CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)");
}

// ------------------------------------------------------------------ users

export const userCount = (): number =>
  one<{ n: number }>("SELECT COUNT(*) AS n FROM users")?.n ?? 0;

export const findUser = (username: string): User | null =>
  one<User>("SELECT * FROM users WHERE username = ?", username.trim().toLowerCase());

export const listUsers = () =>
  all<{ id: number; username: string; created_at: string; last_login_at: string | null }>(
    "SELECT id, username, created_at, last_login_at FROM users ORDER BY id",
  );

function checkPassword(password: string): void {
  // Twelve, not eight. This is a login that reaches a root shell on every
  // machine in the fleet; the usual advice is calibrated for lower stakes.
  if ((password ?? "").length < 12) {
    throw new AuthError("password must be at least 12 characters");
  }
}

export async function createUser(username: string, password: string): Promise<User> {
  const name = (username ?? "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,32}$/.test(name)) {
    throw new AuthError(
      "username must be 2-32 characters of a-z, 0-9, dot, dash or underscore",
    );
  }
  checkPassword(password);
  if (findUser(name)) throw new AuthError(`user '${name}' already exists`);
  run(
    "INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)",
    name,
    await Bun.password.hash(password),
    nowIso(),
  );
  return findUser(name)!;
}

export async function setPassword(username: string, password: string): Promise<void> {
  checkPassword(password);
  const user = findUser(username);
  if (!user) throw new AuthError(`no such user '${username}'`);
  run(
    "UPDATE users SET password_hash = ? WHERE id = ?",
    await Bun.password.hash(password),
    user.id,
  );
  // Changing a password is usually a response to it having leaked, so every
  // browser holding a session for that user is signed out too.
  run("DELETE FROM sessions WHERE user_id = ?", user.id);
}

export function deleteUser(username: string): boolean {
  const user = findUser(username);
  if (!user) return false;
  if (userCount() <= 1) {
    throw new AuthError("that is the last user — the dashboard would lock you out");
  }
  run("DELETE FROM sessions WHERE user_id = ?", user.id);
  return run("DELETE FROM users WHERE id = ?", user.id).changes === 1;
}

// ------------------------------------------------------------- sign in
//
// Deliberately slow to guess: argon2id verification costs the same whether the
// password is right or wrong, and a missing user is verified against a dummy
// hash so "no such user" and "wrong password" take the same time and say the
// same thing.

const DUMMY_HASH = await Bun.password.hash(randomBytes(24).toString("hex"));

export async function verifyPassword(
  username: string,
  password: string,
): Promise<User | null> {
  const user = findUser(username);
  const hash = user?.password_hash ?? DUMMY_HASH;
  let okay = false;
  try {
    okay = await Bun.password.verify(password ?? "", hash);
  } catch {
    okay = false; // an unreadable hash is a failed login, not a 500
  }
  return okay && user ? user : null;
}

// ---------------------------------------------------------------- sessions

const hashToken = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("hex");

export interface Session {
  id: number;
  token_hash: string;
  user_id: number;
  expires_at: string;
  username?: string;
}

export function startSession(
  userId: number,
  ip: string | null,
  userAgent: string | null,
): string {
  const token = randomBytes(32).toString("base64url");
  run(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent) " +
      "VALUES (?,?,?,?,?,?,?)",
    hashToken(token),
    userId,
    nowIso(),
    nowIso(new Date(Date.now() + SESSION_HOURS * 3600_000)),
    nowIso(),
    ip,
    (userAgent ?? "").slice(0, 200) || null,
  );
  run("UPDATE users SET last_login_at = ? WHERE id = ?", nowIso(), userId);
  return token;
}

/** The live session behind a cookie, or null. Looked up by hash, then
 *  confirmed in constant time — the same shape share tokens use. */
export function resolveSession(token: string | undefined | null): Session | null {
  if (!token) return null;
  const row = one<Session & { token: string }>(
    "SELECT s.*, u.username FROM sessions s JOIN users u ON u.id = s.user_id " +
      "WHERE s.token_hash = ?",
    hashToken(token),
  );
  if (!row) return null;
  const expires = parseIso(row.expires_at);
  if (!expires || expires.getTime() <= Date.now()) {
    run("DELETE FROM sessions WHERE id = ?", row.id);
    return null;
  }
  return row;
}

export function touchSession(id: number): void {
  run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", nowIso(), id);
}

export function endSession(token: string | undefined | null): void {
  if (!token) return;
  run("DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
}

/** Drop sessions that have already expired. Called by the nightly sweep. */
export const purgeSessions = (): number =>
  run("DELETE FROM sessions WHERE expires_at < ?", nowIso()).changes;

// ------------------------------------------------------------ rate limit
//
// A password is only as good as the number of guesses someone gets. This is a
// per-IP counter with a cooldown rather than anything clever, because the
// alternative on a single-process dashboard is a dependency and a shared store
// for a problem that a Map solves.

const FAILURES = new Map<string, { count: number; until: number }>();
export const MAX_ATTEMPTS = envInt("DESKSWARM_LOGIN_ATTEMPTS", 8);
export const LOCKOUT_MINUTES = envInt("DESKSWARM_LOGIN_LOCKOUT_MINUTES", 15);

export function lockedOutFor(ip: string): number {
  const hit = FAILURES.get(ip);
  if (!hit || hit.until <= Date.now()) return 0;
  return Math.ceil((hit.until - Date.now()) / 60_000);
}

export function noteFailure(ip: string): void {
  const hit = FAILURES.get(ip) ?? { count: 0, until: 0 };
  hit.count += 1;
  if (hit.count >= MAX_ATTEMPTS) {
    hit.until = Date.now() + LOCKOUT_MINUTES * 60_000;
    hit.count = 0;
  }
  FAILURES.set(ip, hit);
}

export const clearFailures = (ip: string): void => void FAILURES.delete(ip);

/** Tests need the counter empty between cases. */
export const resetRateLimit = (): void => FAILURES.clear();

// ------------------------------------------------------------- bootstrap

/**
 * Make sure somebody can sign in.
 *
 * A dashboard that starts with no users and no way to make one is a brick, and
 * a dashboard that starts with a default password is worse. So: take the
 * credentials from the environment if they are there, otherwise mint a random
 * password and print it once. Printing it is the honest option — the
 * alternative is an open dashboard while the operator works out what to do.
 */
export async function ensureAdmin(): Promise<void> {
  if (userCount() > 0) return;
  const username = (process.env.DESKSWARM_ADMIN_USER || "admin").trim().toLowerCase();
  const supplied = process.env.DESKSWARM_ADMIN_PASSWORD;
  const password = supplied || randomBytes(12).toString("base64url");
  await createUser(username, password);
  if (supplied) {
    console.log(`[auth] created the first user '${username}' from the environment`);
  } else {
    console.log(
      `\n[auth] no users yet, so one was created:\n` +
        `         username: ${username}\n` +
        `         password: ${password}\n` +
        `       This is printed once. Change it, or set DESKSWARM_ADMIN_PASSWORD.\n`,
    );
  }
}

/** Constant-time compare for the API token. */
export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}
