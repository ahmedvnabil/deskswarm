"""The background loop: due schedules, idle machines, nightly housekeeping."""

import time
from datetime import datetime, timedelta, timezone

import audit
import backups
import fleet
import shares
from db import connect
from machines import list_computers, now_iso
from settings import IDLE_SUSPEND_MINUTES
from tasks import dispatch_task


def compute_next_run(kind: str, every_minutes: int | None, at_time: str | None,
                     after: datetime | None = None) -> str:
    now = after or datetime.now(timezone.utc)
    if kind == "interval":
        return (now + timedelta(minutes=every_minutes or 60)).isoformat(timespec="seconds")
    hh, mm = (at_time or "09:00").split(":")
    nxt = now.replace(hour=int(hh), minute=int(mm), second=0, microsecond=0)
    if nxt <= now:
        nxt += timedelta(days=1)
    return nxt.isoformat(timespec="seconds")


def scheduler_tick() -> None:
    """Dispatch every schedule that has come due.

    Claiming is a conditional UPDATE on next_run_at: with several gunicorn
    workers each running this loop, only the one whose UPDATE matches the row
    it read gets to fire, so a schedule never double-dispatches.
    """
    now = datetime.now(timezone.utc)
    conn = connect()
    due = conn.execute(
        "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ?",
        (now.isoformat(timespec="seconds"),),
    ).fetchall()

    for row in due:
        nxt = compute_next_run(row["kind"], row["every_minutes"], row["at_time"], after=now)
        claimed = conn.execute(
            "UPDATE schedules SET next_run_at = ?, last_run_at = ?, run_count = run_count + 1 "
            "WHERE id = ? AND next_run_at = ?",
            (nxt, now.isoformat(timespec="seconds"), row["id"], row["next_run_at"]),
        )
        conn.commit()
        if claimed.rowcount != 1:
            continue  # another worker got it first
        try:
            dispatch_task(row["desktop"], row["description"])
        except Exception:  # noqa: BLE001
            pass
    conn.close()


def idle_tick() -> None:
    """Put machines nobody is watching to sleep.

    Two things count as "in use": a browser with the screen open (an
    established connection to websockify inside the desktop) and a task that
    is pending or running. Anything else has been idle since last_active_at,
    and once that is older than the timeout the machine is stopped.

    Deliberately off by default. Sleeping frees the machine's memory but ends
    its X session, so a surprise suspend costs someone their open windows —
    that has to be a choice, not a default. Machines flagged no_suspend are
    always skipped.
    """
    if IDLE_SUSPEND_MINUTES <= 0:
        return
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=IDLE_SUSPEND_MINUTES)
    conn = connect()
    busy = {r["desktop"] for r in conn.execute(
        "SELECT DISTINCT desktop FROM tasks WHERE status IN ('PENDING','RUNNING')")}
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM computers WHERE no_suspend = 0")]

    for comp in rows:
        if comp["name"] in busy:
            conn.execute("UPDATE computers SET last_active_at = ? WHERE id = ?",
                         (now_iso(), comp["id"]))
            continue
        watchers = fleet.vnc_watchers(comp["slug"])
        if watchers is None:
            continue                      # already asleep, or unreachable
        if watchers > 0:
            conn.execute("UPDATE computers SET last_active_at = ? WHERE id = ?",
                         (now_iso(), comp["id"]))
            continue
        last = comp["last_active_at"]
        if not last:
            # Never seen active — start the clock now rather than suspending a
            # machine the moment the feature is switched on.
            conn.execute("UPDATE computers SET last_active_at = ? WHERE id = ?",
                         (now_iso(), comp["id"]))
            continue
        try:
            if datetime.fromisoformat(last) > cutoff:
                continue
        except ValueError:
            continue
        try:
            fleet.suspend_computer(comp["slug"])
        except Exception:  # noqa: BLE001
            pass
    conn.commit()
    conn.close()


def claim_daily(key: str, at_time: str) -> bool:
    """True at most once per UTC day, for whichever worker gets there first.

    Same conditional-UPDATE trick the task scheduler uses: several gunicorn
    workers run this loop, and a fleet backup that fires once per worker would
    be three times the disk and three times the wall clock.
    """
    try:
        hh, mm = [int(x) for x in at_time.split(":", 1)]
    except (ValueError, AttributeError):
        return False
    now = datetime.now(timezone.utc)
    if (now.hour, now.minute) < (hh, mm):
        return False
    today = now.date().isoformat()

    conn = connect()
    try:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        if row and row["value"] >= today:
            return False
        if row:
            claimed = conn.execute(
                "UPDATE meta SET value = ? WHERE key = ? AND value = ?",
                (today, key, row["value"]))
        else:
            claimed = conn.execute(
                "INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", (key, today))
        conn.commit()
        return claimed.rowcount == 1
    finally:
        conn.close()


def maintenance_tick() -> None:
    """Daily housekeeping: back the fleet up, then trim what has aged out."""
    if backups.DAILY_AT and claim_daily("backup_daily", backups.DAILY_AT):
        for comp in list_computers():
            try:
                meta = backups.create(comp["slug"])
                audit.record("backup (scheduled)", target=comp["name"],
                             detail=f"{meta['name']} ({meta['bytes']} bytes)")
            except Exception as exc:  # noqa: BLE001
                audit.record("backup (scheduled)", target=comp["name"],
                             detail=str(exc)[:300], ok=False)

    if claim_daily("housekeeping", "03:00"):
        conn = connect()
        try:
            audit.prune(conn)
            shares.purge_expired(conn)
        finally:
            conn.close()


def scheduler_loop() -> None:
    while True:
        for tick in (scheduler_tick, idle_tick, maintenance_tick):
            try:
                tick()
            except Exception:  # noqa: BLE001
                pass
        time.sleep(20)
