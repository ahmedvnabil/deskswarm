/**
 * Every environment-derived setting, in one place.
 *
 * Spread across the modules that happen to use them, these become impossible
 * to survey — and the answer to "what can I configure?" should not require
 * reading the whole codebase.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const env = (key: string, fallback = ""): string =>
  process.env[key] ?? fallback;

export const envInt = (key: string, fallback: number): number => {
  const n = parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};

export const envFloat = (key: string, fallback: number): number => {
  const n = parseFloat(process.env[key] ?? "");
  return Number.isFinite(n) ? n : fallback;
};

export const envBool = (key: string, fallback = false): boolean => {
  const raw = (process.env[key] ?? "").toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
};

/** The directory this build runs from — src/ in dev, the same in the image. */
export const BASE_DIR = resolve(import.meta.dir, "..");

export const DB_PATH = resolve(
  env("DESKSWARM_DB_PATH") || `${BASE_DIR}/data/fleet.db`,
);
mkdirSync(dirname(DB_PATH), { recursive: true });
process.env.DESKSWARM_DB_PATH = DB_PATH;

export const TEMPLATE_DIR = `${BASE_DIR}/templates`;

export const PORT = envInt("PORT", 7000);

export const DASHBOARD_TOKEN = env("DASHBOARD_TOKEN");

export const MAX_BULK_CREATE = envInt("DESKSWARM_MAX_BULK_CREATE", 25);

export const PAGE_SIZE = envInt("DESKSWARM_PAGE_SIZE", 25);

export const IDLE_SUSPEND_MINUTES = envInt("DESKSWARM_IDLE_SUSPEND_MINUTES", 0);

export const WAKE_TIMEOUT_SECONDS = envFloat("DESKSWARM_WAKE_TIMEOUT", 45);

export const MAX_CLIPBOARD_KB = envInt("DESKSWARM_MAX_CLIPBOARD_KB", 256);

export const MAX_UPLOAD_MB = envInt("DESKSWARM_MAX_UPLOAD_MB", 64);

export const SHOT_TTL = envFloat("DESKSWARM_SHOT_TTL", 3);

/** Stops the idle-suspend / nightly-backup loop. Tests set it so a suite does
 *  not start suspending the machines it just made up. */
export const DISABLE_HOUSEKEEPING = !!(
  env("DESKSWARM_DISABLE_HOUSEKEEPING") || env("DESKSWARM_DISABLE_SCHEDULER")
);

// --------------------------------------------------------------------- mcp

/**
 * How long one MCP tool call may take before the dashboard gives up on the
 * bridge.
 *
 * Generous, because the calls behind it are not uniform: a screenshot is
 * milliseconds and `shell` may be an `apt-get install`. The client is waiting
 * on an HTTP request either way, so this is the ceiling on how long a wedged
 * machine can hold one open.
 */
export const MCP_CALL_TIMEOUT_SECONDS = envFloat("DESKSWARM_MCP_TIMEOUT", 120);

/** A machine that is asleep is woken by the first MCP call that needs it,
 *  rather than failing — an external client has no sleep/wake button. */
export const MCP_AUTO_WAKE = envBool("DESKSWARM_MCP_AUTO_WAKE", true);

/**
 * The origin an MCP client should be pointed at.
 *
 * Only used to render a ready-to-paste endpoint URL in the UI. Left empty the
 * dashboard derives it from the request, which is right whenever the browser
 * and the MCP client can reach this from the same address — and wrong exactly
 * when someone browses over a LAN address but the client will connect over the
 * public name, which is what this setting is for.
 */
export const MCP_PUBLIC_ORIGIN = env("DESKSWARM_MCP_PUBLIC_ORIGIN").replace(/\/$/, "");

/**
 * How long after its last call a machine still counts as "being worked in".
 *
 * Drives the wall's live outline and keeps the idle sweeper off a machine an
 * outside client is using. Long enough to span an agent thinking between two
 * tool calls, short enough that a finished session stops looking active.
 */
export const LIVE_WINDOW_SECONDS = envInt("DESKSWARM_LIVE_WINDOW", 90);

/**
 * Timestamps, in exactly the shape Python's
 * `datetime.now(timezone.utc).isoformat(timespec="seconds")` produced.
 *
 * `2026-08-06T02:15:58+00:00`, not JavaScript's `...58.123Z`. An existing
 * database is full of the former, and rows are compared as strings all over
 * the schema — next_run_at, expires_at, the audit cutoff. Mixing the two
 * formats would sort them against each other wrongly and silently.
 */
export function nowIso(d: Date = new Date()): string {
  return d.toISOString().replace(/\.\d+Z$/, "+00:00");
}

/** Parse a stored timestamp back. Returns null rather than an Invalid Date,
 *  because every caller has to branch on "unparseable" anyway. */
export function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
