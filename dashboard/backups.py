"""Backing up and restoring a machine's home directory.

A persistent home only half-solves the problem it set out to solve: work
survives a restart, and then one `docker volume rm` — or one mistaken delete
from the wall — takes all of it. This is the other half.

A backup is a gzipped tar of /home/cua, written straight to the dashboard's
data volume. Streamed in both directions: homes run to hundreds of megabytes
and holding one in memory on a host already short of it would be a poor way
to protect against data loss.
"""

import gzip
import os
import re
import shutil
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path

import fleet

BACKUP_DIR = Path(os.environ.get("DESKSWARM_BACKUP_DIR", "/app/data/backups"))
# How many to keep per machine. Backups are the thing most likely to fill a
# disk quietly, and a full disk breaks Docker in confusing ways.
KEEP_PER_MACHINE = int(os.environ.get("DESKSWARM_BACKUP_KEEP", "5"))
# 'HH:MM' UTC to back the whole fleet up daily; empty disables it.
DAILY_AT = os.environ.get("DESKSWARM_BACKUP_DAILY_AT", "").strip()

CHUNK = 1024 * 1024

NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")


class BadBackupName(ValueError):
    """A name that would escape the backup directory."""


def machine_dir(slug: str) -> Path:
    if not NAME_RE.match(slug):
        raise BadBackupName(f"bad machine name '{slug}'")
    return BACKUP_DIR / slug


def backup_path(slug: str, name: str) -> Path:
    """Resolve one backup file, refusing anything that climbs out.

    The name reaches here from a URL, so '../../etc/passwd' has to bounce at
    this line rather than at open().
    """
    if not NAME_RE.match(name or ""):
        raise BadBackupName(f"bad backup name '{name}'")
    base = machine_dir(slug).resolve()
    target = (base / name).resolve()
    if target != base and base not in target.parents:
        raise BadBackupName(f"'{name}' is outside {base}")
    return target


def stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def create(slug: str) -> dict:
    """Write a new backup of one machine's home. Returns its metadata.

    Works on a sleeping machine too — Docker serves a stopped container's
    filesystem — so backing up the fleet doesn't mean waking all of it.
    """
    out_dir = machine_dir(slug)
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{stamp()}.tar.gz"
    final = out_dir / name
    # Write to a partial file and rename at the end: a backup interrupted
    # half-way must not be left looking like a complete one.
    partial = final.with_suffix(".partial")

    stream = fleet.home_archive_stream(slug)
    started = time.monotonic()
    try:
        with gzip.open(partial, "wb", compresslevel=6) as gz:
            for chunk in stream:
                gz.write(chunk)
        partial.replace(final)
    except Exception:
        partial.unlink(missing_ok=True)
        raise

    prune(slug)
    return {
        "name": name,
        "machine": slug,
        "bytes": final.stat().st_size,
        "seconds": round(time.monotonic() - started, 1),
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def listing(slug: str) -> list[dict]:
    out_dir = machine_dir(slug)
    if not out_dir.is_dir():
        return []
    rows = []
    for f in sorted(out_dir.glob("*.tar.gz"), reverse=True):
        st = f.stat()
        rows.append({
            "name": f.name,
            "machine": slug,
            "bytes": st.st_size,
            "created_at": datetime.fromtimestamp(st.st_mtime, timezone.utc)
                                  .isoformat(timespec="seconds"),
        })
    return rows


def prune(slug: str) -> list[str]:
    if KEEP_PER_MACHINE <= 0:
        return []
    dropped = []
    for row in listing(slug)[KEEP_PER_MACHINE:]:
        (machine_dir(slug) / row["name"]).unlink(missing_ok=True)
        dropped.append(row["name"])
    return dropped


def remove(slug: str, name: str) -> bool:
    path = backup_path(slug, name)
    if not path.is_file():
        return False
    path.unlink()
    return True


def total_bytes() -> int:
    if not BACKUP_DIR.is_dir():
        return 0
    return sum(f.stat().st_size for f in BACKUP_DIR.rglob("*.tar.gz"))


def is_safe(member: tarfile.TarInfo) -> bool:
    """Whether this entry stays inside the home directory.

    A tar is a list of paths chosen by whoever wrote it. These are our own
    archives today, but restore also accepts an uploaded file, and a member
    called '../../etc/cron.d/x' — or a symlink pointing at /etc that a later
    member then writes through — is the oldest trick there is. It has to be
    refused here, before anything is unpacked.
    """
    name = os.path.normpath(member.name)
    if name.startswith(("/", "..")) or name == "." or "/../" in name:
        return False
    if member.issym() or member.islnk():
        if os.path.isabs(member.linkname):
            return False
        target = os.path.normpath(os.path.join(os.path.dirname(name), member.linkname))
        if target.startswith(".."):
            return False
    return not (member.isdev() or member.ischr() or member.isblk() or member.isfifo())


def sanitise(source: Path, dest: Path) -> int:
    """Rewrite a backup into a tar holding only entries that are safe to
    unpack, owned by the desktop user. Returns how many survived.

    Read as a stream so a large archive never lands in memory; that also means
    one pass, so filtering happens per member as it arrives.
    """
    kept = 0
    with gzip.open(source, "rb") as gz, \
            tarfile.open(fileobj=gz, mode="r|") as src, \
            tarfile.open(dest, mode="w") as out:
        for member in src:
            if not is_safe(member):
                continue
            member.uid = member.gid = 1000        # the desktop session is `cua`
            member.uname = member.gname = "cua"
            out.addfile(member, src.extractfile(member) if member.isfile() else None)
            kept += 1
    return kept


def restore(slug: str, source: Path, wipe: bool = True) -> dict:
    """Replace a machine's home from a backup.

    The machine is stopped for the duration. Overwriting .config and friends
    underneath a live X session leaves the desktop reading half of one home
    and half of another, and that surfaces minutes later as something that
    looks unrelated.
    """
    was_running = fleet.is_running(slug)
    if was_running:
        fleet.suspend_computer(slug)

    staged = Path(str(source) + f".staged-{os.getpid()}.tar")
    try:
        kept = sanitise(source, staged)
        fleet.restore_home(slug, staged, wipe=wipe)
    finally:
        staged.unlink(missing_ok=True)
        if was_running:
            fleet.resume_computer(slug)
    return {"machine": slug, "entries": kept, "restarted": was_running}


def disk_free_gb() -> float | None:
    try:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        return round(shutil.disk_usage(BACKUP_DIR).free / 1e9, 1)
    except Exception:  # noqa: BLE001
        return None
