/**
 * The background loop: idle machines, nightly backups, trimming what has aged
 * out.
 *
 * This was `scheduler.ts`, and most of it was dispatching agent tasks that had
 * come due. That part is gone with the rest of the agent layer — but the rest
 * of the loop was never about tasks at all, and a fleet with no nightly backup
 * and an audit table that grows for ever is a worse deal than the one this
 * replaced.
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
import * as keys from "./mcp/keys";
import { busyMachines } from "./mcp/activity";
import { providerFor } from "./providers";
import * as shares from "./shares";
import { all, one, run } from "./db";
import { listComputers, type Computer } from "./machines";
import { envInt, nowIso, parseIso } from "./settings";

/**
 * Put machines nobody is watching to sleep.
 *
 * Two things count as "in use": a browser with the screen open (an established
 * connection to websockify inside the desktop) and an MCP client that has
 * called the machine recently. The second used to be "a task is running";
 * without it, a machine an outside agent is working in would be suspended
 * mid-session and the agent would watch its desktop disappear.
 *
 * Deliberately off by default. Sleeping frees the machine's memory but ends
 * its X session, so a surprise suspend costs someone their open windows.
 * Machines flagged no_suspend are always skipped.
 */
export async function idleTick(): Promise<void> {
  const minutes = envInt("DESKSWARM_IDLE_SUSPEND_MINUTES", 0);
  if (minutes <= 0) return;
  const cutoff = Date.now() - minutes * 60_000;
  const busy = busyMachines();
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
 * A fleet backup that fires once per worker would be three times the disk and
 * three times the wall clock.
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
    keys.purgeExpired();
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

export function startHousekeeping(): void {
  const loop = async () => {
    for (const tick of [idleTick, maintenanceTick]) {
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

export function stopHousekeeping(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
