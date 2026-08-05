"""
Guards against the failures that accumulate quietly.

deskswarm already recovers from *process* failures: containers restart, tasks
orphaned by a restart get failed, a stuck agent hits its timeout. What it had
no answer for was the slow kind — a disk filling with snapshots, memory
running out one machine at a time, a schedule quietly burning money, or every
task failing because the model provider is down. Those hurt more precisely
because nothing announces them.

Every guard is a plain function returning (ok, message) so the caller decides
whether to refuse or merely warn, and each can be switched off with an env
var for people who want to manage this themselves.
"""

import os
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone

# 0 disables the cap. Deliberately off by default: a limit that surprises
# someone mid-run is worse than no limit, so it should be a choice.
DAILY_COST_LIMIT = float(os.environ.get("DESKSWARM_DAILY_COST_LIMIT", "0"))

# A machine is two containers and both cost real memory. Measured on an idle
# fleet: the desktop runs 200-235 MB and the bridge another 145-190 MB, so a
# machine is ~400 MB before it does any work — a browser alone pushes its
# desktop past 600 MB. An earlier 300 default counted only the desktop and
# under-committed the budget by about a third.
MACHINE_MB = int(os.environ.get("DESKSWARM_MACHINE_MB", "400"))
MIN_FREE_MB = int(os.environ.get("DESKSWARM_MIN_FREE_MB", "512"))

MIN_FREE_DISK_GB = float(os.environ.get("DESKSWARM_MIN_FREE_DISK_GB", "5"))
LOW_DISK_WARN_GB = float(os.environ.get("DESKSWARM_LOW_DISK_WARN_GB", "15"))

# If this many tasks in a row have failed, something systemic is wrong —
# usually the model provider — and dispatching more just spends money.
FAILURE_BREAKER = int(os.environ.get("DESKSWARM_FAILURE_BREAKER", "5"))
BREAKER_COOLDOWN_MIN = int(os.environ.get("DESKSWARM_BREAKER_COOLDOWN_MIN", "10"))


# ------------------------------------------------------------------- cost

def todays_spend(conn: sqlite3.Connection) -> float:
    row = conn.execute(
        "SELECT COALESCE(SUM(cost_usd), 0) AS c FROM tasks "
        "WHERE date(updated_at) = date('now')"
    ).fetchone()
    return round(row["c"] if isinstance(row, sqlite3.Row) else row[0], 4)


def check_cost(conn: sqlite3.Connection) -> tuple[bool, str]:
    if DAILY_COST_LIMIT <= 0:
        return True, ""
    spend = todays_spend(conn)
    if spend < DAILY_COST_LIMIT:
        return True, ""
    return False, (
        f"daily cost limit reached — ${spend:.2f} of ${DAILY_COST_LIMIT:.2f} spent today. "
        f"Raise DESKSWARM_DAILY_COST_LIMIT or wait for the next UTC day."
    )


# ----------------------------------------------------------------- memory

# An explicit budget in MB for the whole fleet. Needed more often than it
# looks: when the dashboard runs in Docker inside an LXC or a VM with a memory
# cap, /proc/meminfo shows the *outer host's* memory and the container's own
# cgroup says "max", so nothing visible from in here knows the real ceiling.
# Measured on a Proxmox LXC capped at 8 GB, /proc/meminfo reported 63 GB — the
# guard would have waved machines through until the OOM killer started
# choosing victims, which is the exact failure it exists to prevent.
MEMORY_BUDGET_MB = int(os.environ.get("DESKSWARM_MEMORY_BUDGET_MB", "0"))


def cgroup_limit_mb() -> int | None:
    """The container's own memory cap, when it has one."""
    for path, unlimited in (("/sys/fs/cgroup/memory.max", "max"),
                            ("/sys/fs/cgroup/memory/memory.limit_in_bytes", None)):
        try:
            raw = open(path).read().strip()
        except OSError:
            continue
        if raw == unlimited:
            continue
        try:
            val = int(raw)
        except ValueError:
            continue
        # cgroup v1 spells "no limit" as an enormous number.
        if val < (1 << 62):
            return val // (1024 * 1024)
    return None


def meminfo_available_mb() -> int | None:
    """MemAvailable, which counts reclaimable cache — free alone refuses far
    too eagerly."""
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except Exception:  # noqa: BLE001
        pass
    return None


def memory_report(machines: int = 0) -> dict:
    """How much room is left, and how we know.

    With an explicit budget the arithmetic is deterministic — budget minus what
    the fleet is estimated to use — which beats a reading that may describe the
    wrong machine entirely.
    """
    if MEMORY_BUDGET_MB > 0:
        return {"available_mb": max(0, MEMORY_BUDGET_MB - machines * MACHINE_MB),
                "source": "budget", "trusted": True}
    cg = cgroup_limit_mb()
    if cg:
        return {"available_mb": max(0, cg - machines * MACHINE_MB),
                "source": "cgroup", "trusted": True}
    return {"available_mb": meminfo_available_mb(), "source": "meminfo",
            "trusted": False}


def available_mb() -> int | None:
    return memory_report().get("available_mb")


def check_memory(count: int = 1, machines: int = 0) -> tuple[bool, str]:
    rep = memory_report(machines)
    avail = rep["available_mb"]
    if avail is None:
        return True, ""   # can't tell; don't block on a guess
    needed = MACHINE_MB * count + MIN_FREE_MB
    if avail >= needed:
        return True, ""
    fits = max(0, (avail - MIN_FREE_MB) // MACHINE_MB)
    hint = "" if rep["trusted"] else (
        " This reading comes from /proc/meminfo, which shows the host's memory "
        "rather than this container's share — set DESKSWARM_MEMORY_BUDGET_MB if "
        "you run under an LXC or VM cap."
    )
    return False, (
        f"not enough memory — {avail} MB available, {needed} MB needed for "
        f"{count} machine(s). Room for about {fits} more.{hint}"
    )


# ------------------------------------------------------------------- disk

def disk_free_gb() -> float | None:
    try:
        return round(shutil.disk_usage("/").free / 1e9, 1)
    except Exception:  # noqa: BLE001
        return None


def check_disk() -> tuple[bool, str]:
    free = disk_free_gb()
    if free is None:
        return True, ""
    if free >= MIN_FREE_DISK_GB:
        return True, ""
    return False, (
        f"only {free} GB of disk left. Snapshots are 2–6 GB each; Docker starts "
        f"failing in confusing ways when it runs out. Delete a snapshot or run "
        f"the space reclaim from the dashboard."
    )


def disk_warning() -> str:
    """Non-blocking nudge, so low disk is visible before it is fatal."""
    free = disk_free_gb()
    if free is None or free >= LOW_DISK_WARN_GB:
        return ""
    return f"{free} GB of disk left — snapshots are 2–6 GB each."


# ---------------------------------------------------------------- breaker

def consecutive_failures(conn: sqlite3.Connection) -> tuple[int, str | None]:
    rows = conn.execute(
        "SELECT status, updated_at FROM tasks "
        "WHERE status IN ('COMPLETED', 'FAILED') ORDER BY id DESC LIMIT ?",
        (FAILURE_BREAKER,),
    ).fetchall()
    n = 0
    last = None
    for r in rows:
        if r["status"] != "FAILED":
            break
        n += 1
        last = last or r["updated_at"]
    return n, last


def check_breaker(conn: sqlite3.Connection) -> tuple[bool, str]:
    if FAILURE_BREAKER <= 0:
        return True, ""
    n, last = consecutive_failures(conn)
    if n < FAILURE_BREAKER:
        return True, ""
    # After the cooldown, let one through: if the provider recovered we want to
    # find out, and a breaker that never re-tries is just an outage of its own.
    if last:
        try:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(last)
            if age > timedelta(minutes=BREAKER_COOLDOWN_MIN):
                return True, ""
        except ValueError:
            pass
    return False, (
        f"the last {n} tasks all failed, so dispatch is paused — usually the model "
        f"provider is unreachable or the key is wrong. Check a failed task's error, "
        f"then retry; it clears itself after {BREAKER_COOLDOWN_MIN} minutes anyway."
    )


# --------------------------------------------------------------- summary

def status(conn: sqlite3.Connection, machines: int = 0) -> dict:
    fails, _ = consecutive_failures(conn)
    cost_ok, cost_msg = check_cost(conn)
    mem_ok, mem_msg = check_memory(1, machines)
    mem = memory_report(machines)
    disk_ok, disk_msg = check_disk()
    brk_ok, brk_msg = check_breaker(conn)
    return {
        "spend_today_usd": todays_spend(conn),
        "daily_cost_limit_usd": DAILY_COST_LIMIT or None,
        "memory_available_mb": mem["available_mb"],
        "memory_source": mem["source"],
        "disk_free_gb": disk_free_gb(),
        "consecutive_failures": fails,
        "blocking": [m for m in (cost_msg, brk_msg) if m],
        "warnings": [m for m in (mem_msg, disk_msg, disk_warning()) if m],
        "ok": all((cost_ok, mem_ok, disk_ok, brk_ok)),
    }
