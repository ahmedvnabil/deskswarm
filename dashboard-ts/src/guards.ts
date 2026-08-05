/**
 * Guards against the failures that accumulate quietly.
 *
 * deskswarm already recovers from *process* failures: containers restart,
 * tasks orphaned by a restart get failed, a stuck agent hits its timeout. What
 * it had no answer for was the slow kind — a disk filling with snapshots,
 * memory running out one machine at a time, a schedule quietly burning money,
 * or every task failing because the model provider is down.
 *
 * Every guard is a plain function returning [ok, message] so the caller decides
 * whether to refuse or merely warn, and each can be switched off with an env
 * var for people who want to manage this themselves.
 */

import { readFileSync, statfsSync } from "node:fs";
import { all, one } from "./db";
import { envFloat, envInt, parseIso } from "./settings";

export type Check = [ok: boolean, message: string];

/**
 * Every threshold, read at call time rather than captured at import.
 *
 * A limit that only takes effect after a restart is a limit people believe
 * they have set and have not — and it makes each of these testable without a
 * process per configuration.
 */
export const limits = {
  // 0 disables the cap. Deliberately off by default: a limit that surprises
  // someone mid-run is worse than no limit, so it should be a choice.
  dailyCostLimit: () => envFloat("DESKSWARM_DAILY_COST_LIMIT", 0),
  // A machine is two containers and both cost real memory. Measured on an idle
  // fleet: the desktop runs 200-235 MB and the bridge another 145-190 MB.
  machineMb: () => envInt("DESKSWARM_MACHINE_MB", 400),
  minFreeMb: () => envInt("DESKSWARM_MIN_FREE_MB", 512),
  minFreeDiskGb: () => envFloat("DESKSWARM_MIN_FREE_DISK_GB", 5),
  lowDiskWarnGb: () => envFloat("DESKSWARM_LOW_DISK_WARN_GB", 15),
  // If this many tasks in a row have failed, something systemic is wrong —
  // usually the model provider — and dispatching more just spends money.
  failureBreaker: () => envInt("DESKSWARM_FAILURE_BREAKER", 5),
  breakerCooldownMin: () => envInt("DESKSWARM_BREAKER_COOLDOWN_MIN", 10),
  // An explicit budget in MB for the whole fleet. Needed more often than it
  // looks: when the dashboard runs in Docker inside an LXC or a VM with a
  // memory cap, /proc/meminfo shows the *outer host's* memory and the
  // container's own cgroup says "max", so nothing in here knows the ceiling.
  memoryBudgetMb: () => envInt("DESKSWARM_MEMORY_BUDGET_MB", 0),
};

/**
 * The readings that come from the operating system.
 *
 * Grouped into one replaceable object because they are the only part of this
 * module that cannot be reasoned about from its inputs — and because a test
 * that wants to describe a nearly-full disk should not have to fill one.
 */
export const probes = {
  cgroupLimitMb,
  meminfoAvailableMb,
  diskFreeGb,
};

const round = (n: number, places: number) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

// ------------------------------------------------------------------- cost

export function todaysSpend(): number {
  const row = one<{ c: number }>(
    "SELECT COALESCE(SUM(cost_usd), 0) AS c FROM tasks " +
      "WHERE date(updated_at) = date('now')",
  );
  return round(row?.c ?? 0, 4);
}

export function checkCost(): Check {
  const cap = limits.dailyCostLimit();
  if (cap <= 0) return [true, ""];
  const spend = todaysSpend();
  if (spend < cap) return [true, ""];
  return [
    false,
    `daily cost limit reached — $${spend.toFixed(2)} of ` +
      `$${cap.toFixed(2)} spent today. ` +
      `Raise DESKSWARM_DAILY_COST_LIMIT or wait for the next UTC day.`,
  ];
}

// ----------------------------------------------------------------- memory

/** The container's own memory cap, when it has one. */
export function cgroupLimitMb(): number | null {
  const sources: [string, string | null][] = [
    ["/sys/fs/cgroup/memory.max", "max"],
    ["/sys/fs/cgroup/memory/memory.limit_in_bytes", null],
  ];
  for (const [path, unlimited] of sources) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8").trim();
    } catch {
      continue;
    }
    if (raw === unlimited) continue;
    const val = Number(raw);
    if (!Number.isFinite(val)) continue;
    // cgroup v1 spells "no limit" as an enormous number.
    if (val < 2 ** 62) return Math.floor(val / (1024 * 1024));
  }
  return null;
}

/** MemAvailable, which counts reclaimable cache — free alone refuses far too
 *  eagerly. */
export function meminfoAvailableMb(): number | null {
  try {
    for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
      if (line.startsWith("MemAvailable:")) {
        return Math.floor(parseInt(line.split(/\s+/)[1], 10) / 1024);
      }
    }
  } catch {
    /* not Linux, or no procfs */
  }
  return null;
}

export interface MemoryReport {
  available_mb: number | null;
  source: string;
  trusted: boolean;
}

/**
 * How much room is left, and how we know.
 *
 * With an explicit budget the arithmetic is deterministic — budget minus what
 * the fleet is estimated to use — which beats a reading that may describe the
 * wrong machine entirely.
 */
export function memoryReport(machines = 0): MemoryReport {
  const budget = limits.memoryBudgetMb();
  if (budget > 0) {
    return {
      available_mb: Math.max(0, budget - machines * limits.machineMb()),
      source: "budget",
      trusted: true,
    };
  }
  const cg = probes.cgroupLimitMb();
  if (cg) {
    return {
      available_mb: Math.max(0, cg - machines * limits.machineMb()),
      source: "cgroup",
      trusted: true,
    };
  }
  return {
    available_mb: probes.meminfoAvailableMb(),
    source: "meminfo",
    trusted: false,
  };
}

export const availableMb = () => memoryReport().available_mb;

export function checkMemory(count = 1, machines = 0): Check {
  const rep = memoryReport(machines);
  const avail = rep.available_mb;
  if (avail === null) return [true, ""]; // can't tell; don't block on a guess
  const needed = limits.machineMb() * count + limits.minFreeMb();
  if (avail >= needed) return [true, ""];
  const fits = Math.max(0, Math.floor((avail - limits.minFreeMb()) / limits.machineMb()));
  const hint = rep.trusted
    ? ""
    : " This reading comes from /proc/meminfo, which shows the host's memory " +
      "rather than this container's share — set DESKSWARM_MEMORY_BUDGET_MB if " +
      "you run under an LXC or VM cap.";
  return [
    false,
    `not enough memory — ${avail} MB available, ${needed} MB needed for ` +
      `${count} machine(s). Room for about ${fits} more.${hint}`,
  ];
}

// ------------------------------------------------------------------- disk

export function diskFreeGb(path = "/"): number | null {
  try {
    const st = statfsSync(path);
    return round((Number(st.bavail) * Number(st.bsize)) / 1e9, 1);
  } catch {
    return null;
  }
}

export function checkDisk(): Check {
  const free = probes.diskFreeGb();
  if (free === null) return [true, ""];
  if (free >= limits.minFreeDiskGb()) return [true, ""];
  return [
    false,
    `only ${free} GB of disk left. Snapshots are 2–6 GB each; Docker starts ` +
      `failing in confusing ways when it runs out. Delete a snapshot or run ` +
      `the space reclaim from the dashboard.`,
  ];
}

/** Non-blocking nudge, so low disk is visible before it is fatal. */
export function diskWarning(): string {
  const free = probes.diskFreeGb();
  if (free === null || free >= limits.lowDiskWarnGb()) return "";
  return `${free} GB of disk left — snapshots are 2–6 GB each.`;
}

// ---------------------------------------------------------------- breaker

export function consecutiveFailures(): [number, string | null] {
  const rows = all<{ status: string; updated_at: string }>(
    "SELECT status, updated_at FROM tasks " +
      "WHERE status IN ('COMPLETED', 'FAILED') ORDER BY id DESC LIMIT ?",
    limits.failureBreaker(),
  );
  let n = 0;
  let last: string | null = null;
  for (const r of rows) {
    if (r.status !== "FAILED") break;
    n += 1;
    last = last || r.updated_at;
  }
  return [n, last];
}

export function checkBreaker(): Check {
  const breaker = limits.failureBreaker();
  if (breaker <= 0) return [true, ""];
  const [n, last] = consecutiveFailures();
  if (n < breaker) return [true, ""];
  // After the cooldown, let one through: if the provider recovered we want to
  // find out, and a breaker that never re-tries is just an outage of its own.
  const at = parseIso(last);
  if (at && Date.now() - at.getTime() > limits.breakerCooldownMin() * 60_000) {
    return [true, ""];
  }
  return [
    false,
    `the last ${n} tasks all failed, so dispatch is paused — usually the model ` +
      `provider is unreachable or the key is wrong. Check a failed task's error, ` +
      `then retry; it clears itself after ${limits.breakerCooldownMin()} minutes anyway.`,
  ];
}

// --------------------------------------------------------------- summary

export function status(machines = 0) {
  const [fails] = consecutiveFailures();
  const [costOk, costMsg] = checkCost();
  const [memOk, memMsg] = checkMemory(1, machines);
  const mem = memoryReport(machines);
  const [diskOk, diskMsg] = checkDisk();
  const [brkOk, brkMsg] = checkBreaker();
  return {
    spend_today_usd: todaysSpend(),
    daily_cost_limit_usd: limits.dailyCostLimit() || null,
    memory_available_mb: mem.available_mb,
    memory_source: mem.source,
    disk_free_gb: probes.diskFreeGb(),
    consecutive_failures: fails,
    blocking: [costMsg, brkMsg].filter(Boolean),
    warnings: [memMsg, diskMsg, diskWarning()].filter(Boolean),
    ok: costOk && memOk && diskOk && brkOk,
  };
}
