/**
 * Guards against the failures that accumulate quietly.
 *
 * Containers restart and a wedged machine can be recreated in place. What
 * deskswarm had no answer for was the slow kind — a disk filling with
 * snapshots, memory running out one machine at a time.
 *
 * Every guard is a plain function returning [ok, message] so the caller decides
 * whether to refuse or merely warn, and each can be switched off with an env
 * var for people who want to manage this themselves.
 */

import { readFileSync, statfsSync } from "node:fs";
import { busyMachines } from "./mcp/activity";
import { envFloat, envInt } from "./settings";

export type Check = [ok: boolean, message: string];

/**
 * Every threshold, read at call time rather than captured at import.
 *
 * A limit that only takes effect after a restart is a limit people believe
 * they have set and have not — and it makes each of these testable without a
 * process per configuration.
 */
export const limits = {
  // A machine is two containers and both cost real memory. Measured on an idle
  // fleet: the desktop runs 200-235 MB and the bridge another 145-190 MB. A
  // machine an MCP client is actually working in costs considerably more, so
  // this is a floor, not a forecast — see DESKSWARM_MEMORY_BUDGET_MB.
  machineMb: () => envInt("DESKSWARM_MACHINE_MB", 400),
  minFreeMb: () => envInt("DESKSWARM_MIN_FREE_MB", 512),
  minFreeDiskGb: () => envFloat("DESKSWARM_MIN_FREE_DISK_GB", 5),
  lowDiskWarnGb: () => envFloat("DESKSWARM_LOW_DISK_WARN_GB", 15),
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

// --------------------------------------------------------------- summary

export function status(machines = 0) {
  const [memOk, memMsg] = checkMemory(1, machines);
  const mem = memoryReport(machines);
  const [diskOk, diskMsg] = checkDisk();
  return {
    memory_available_mb: mem.available_mb,
    memory_source: mem.source,
    disk_free_gb: probes.diskFreeGb(),
    machines_in_use: busyMachines().size,
    // Kept as a field rather than dropped: nothing blocks any more now that
    // the cost cap and the failure breaker are gone, but the panel, the API
    // shape and anything watching /api/v1/guards all still read it.
    blocking: [] as string[],
    warnings: [memMsg, diskMsg, diskWarning()].filter(Boolean),
    ok: memOk && diskOk,
  };
}
