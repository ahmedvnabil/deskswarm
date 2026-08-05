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
// Settled once, here, because the worker subprocess inherits it.
process.env.DESKSWARM_DB_PATH = DB_PATH;

/** The Python worker that drives one agent session. Still Python: the cua
 *  agent loop has no published TypeScript equivalent, and shelling out to it
 *  is a smaller, better-understood surface than reimplementing it. */
export const RUN_TASK_SCRIPT = `${BASE_DIR}/run_task.py`;
export const PYTHON = env("DESKSWARM_PYTHON", "python3");

export const TEMPLATE_DIR = `${BASE_DIR}/templates`;

export const PORT = envInt("PORT", 7000);

export const TASK_TIMEOUT_SECONDS = envInt("DESKSWARM_TASK_TIMEOUT", 300);

export const DASHBOARD_TOKEN = env("DASHBOARD_TOKEN");

export const MAX_BULK_CREATE = envInt("DESKSWARM_MAX_BULK_CREATE", 25);

export const PAGE_SIZE = envInt("DESKSWARM_PAGE_SIZE", 25);

// A task costs a subprocess plus an agent session. Without a ceiling, "run on
// the whole fleet" across a large fleet would start them all at once.
export const MAX_CONCURRENT_TASKS = envInt("DESKSWARM_MAX_CONCURRENT_TASKS", 8);

export const IDLE_SUSPEND_MINUTES = envInt("DESKSWARM_IDLE_SUSPEND_MINUTES", 0);

export const WAKE_TIMEOUT_SECONDS = envFloat("DESKSWARM_WAKE_TIMEOUT", 45);

export const MAX_CLIPBOARD_KB = envInt("DESKSWARM_MAX_CLIPBOARD_KB", 256);

export const MAX_UPLOAD_MB = envInt("DESKSWARM_MAX_UPLOAD_MB", 64);

export const SHOT_TTL = envFloat("DESKSWARM_SHOT_TTL", 3);

export const DISABLE_SCHEDULER = !!env("DESKSWARM_DISABLE_SCHEDULER");

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
