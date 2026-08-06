/**
 * The background loop: due schedules, idle machines, nightly housekeeping.
 *
 * The conditional-UPDATE claiming below is no longer strictly required — one
 * Bun process replaces the several gunicorn workers that each ran this loop —
 * but it is kept because it is also what makes it safe to point a second
 * dashboard at the same database, and because losing it would be invisible
 * until the day someone does.
 */

import * as audit from "./audit";
import * as auth from "./auth";
import * as backups from "./backups";
import { providerFor } from "./providers";
import * as shares from "./shares";
import { all, one, run } from "./db";
import { listComputers, type Computer } from "./machines";
import { envInt, nowIso, parseIso } from "./settings";
import { dispatchTask } from "./tasks";

export function computeNextRun(
  kind: string,
  everyMinutes: number | null,
  atTime: string | null,
  after?: Date,
): string {
  const now = after ?? new Date();
  if (kind === "interval") {
    return nowIso(new Date(now.getTime() + (everyMinutes || 60) * 60_000));
  }
  const [hh, mm] = (atTime || "09:00").split(":");
  const next = new Date(now);
  next.setUTCHours(parseInt(hh, 10), parseInt(mm, 10), 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return nowIso(next);
}

interface ScheduleRow {
  id: number;
  desktop: string;
  description: string;
  kind: string;
  every_minutes: number | null;
  at_time: string | null;
  next_run_at: string;
}

/**
 * Dispatch every schedule that has come due.
 *
 * Claiming is a conditional UPDATE on next_run_at: only the caller whose
 * UPDATE matches the row it read gets to fire, so a schedule never
 * double-dispatches.
 */
export function schedulerTick(): void {
  const now = new Date();
  const due = all<ScheduleRow>(
    "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ?",
    nowIso(now),
  );

  for (const row of due) {
    const next = computeNextRun(row.kind, row.every_minutes, row.at_time, now);
    const claimed = run(
      "UPDATE schedules SET next_run_at = ?, last_run_at = ?, run_count = run_count + 1 " +
        "WHERE id = ? AND next_run_at = ?",
      next,
      nowIso(now),
      row.id,
      row.next_run_at,
    );
    if (claimed.changes !== 1) continue; // someone else got it first
    try {
      dispatchTask(row.desktop, row.description);
    } catch {
      /* a schedule that can't dispatch must not stop the loop */
    }
  }
}

/**
 * Put machines nobody is watching to sleep.
 *
 * Two things count as "in use": a browser with the screen open (an established
 * connection to websockify inside the desktop) and a task that is pending or
 * running. Anything else has been idle since last_active_at.
 *
 * Deliberately off by default. Sleeping frees the machine's memory but ends
 * its X session, so a surprise suspend costs someone their open windows.
 * Machines flagged no_suspend are always skipped.
 */
export async function idleTick(): Promise<void> {
  const minutes = envInt("DESKSWARM_IDLE_SUSPEND_MINUTES", 0);
  if (minutes <= 0) return;
  const cutoff = Date.now() - minutes * 60_000;
  const busy = new Set(
    all<{ desktop: string }>(
      "SELECT DISTINCT desktop FROM tasks WHERE status IN ('PENDING','RUNNING')",
    ).map((r) => r.desktop),
  );
  const rows = all<Computer>("SELECT * FROM computers WHERE no_suspend = 0");

  const touch = (id: number) =>
    run("UPDATE computers SET last_active_at = ? WHERE id = ?", nowIso(), id);

  for (const comp of rows) {
    if (busy.has(comp.name)) {
      touch(comp.id);
      continue;
    }
    const backend = providerFor(comp);
    const watchers = await backend.vncWatchers(comp.slug);
    if (watchers === null) continue; // already asleep, or unreachable
    if (watchers > 0) {
      touch(comp.id);
      continue;
    }
    const last = parseIso(comp.last_active_at);
    if (!last) {
      // Never seen active — start the clock now rather than suspending a
      // machine the moment the feature is switched on.
      touch(comp.id);
      continue;
    }
    if (last.getTime() > cutoff) continue;
    try {
      await backend.suspendComputer(comp.slug);
    } catch {
      /* a machine that won't stop is not a reason to skip the rest */
    }
  }
}

/**
 * True at most once per UTC day, for whichever caller gets there first.
 *
 * Same conditional-UPDATE trick the task scheduler uses: a fleet backup that
 * fires once per worker would be three times the disk and three times the wall
 * clock.
 */
export function claimDaily(key: string, atTime: string): boolean {
  const parts = (atTime || "").split(":");
  const hh = parseInt(parts[0], 10);
  const mm = parseInt(parts[1], 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return false;

  const now = new Date();
  if (
    now.getUTCHours() < hh ||
    (now.getUTCHours() === hh && now.getUTCMinutes() < mm)
  ) {
    return false;
  }
  const today = now.toISOString().slice(0, 10);

  const row = one<{ value: string }>("SELECT value FROM meta WHERE key = ?", key);
  if (row && row.value >= today) return false;
  const claimed = row
    ? run("UPDATE meta SET value = ? WHERE key = ? AND value = ?", today, key, row.value)
    : run("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", key, today);
  return claimed.changes === 1;
}

/** Daily housekeeping: back the fleet up, then trim what has aged out. */
export async function maintenanceTick(): Promise<void> {
  if (backups.DAILY_AT && claimDaily("backup_daily", backups.DAILY_AT)) {
    for (const comp of listComputers()) {
      try {
        const meta = await backups.create(comp.slug);
        audit.record("backup (scheduled)", {
          target: comp.name,
          detail: `${meta.name} (${meta.bytes} bytes)`,
        });
      } catch (err: any) {
        audit.record("backup (scheduled)", {
          target: comp.name,
          detail: String(err?.message ?? err).slice(0, 300),
          ok: false,
        });
      }
    }
  }

  if (claimDaily("housekeeping", "03:00")) {
    audit.prune();
    auth.purgeSessions();
    shares.purgeExpired();
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

export function startScheduler(): void {
  const loop = async () => {
    for (const tick of [schedulerTick, idleTick, maintenanceTick]) {
      try {
        await tick();
      } catch {
        /* one failing tick must not stop the loop */
      }
    }
    timer = setTimeout(loop, 20_000);
  };
  void loop();
}

export function stopScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
