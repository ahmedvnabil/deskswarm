"""Who did what, and from where.

Once a machine can be shared with someone else, "the dashboard did it" stops
being a useful answer. Every state-changing request lands here, recorded by a
single `after_request` hook rather than by calls sprinkled through the
handlers — a log you have to remember to write is a log with holes in it, and
the holes are always in the endpoints that matter.

Contents are deliberately not recorded: the command a shell ran is, because
that is the point of the log, but clipboard text and file bodies are only
ever counted. An audit trail that quietly archives everything anyone typed is
its own kind of problem.
"""

import json
import os
from datetime import datetime, timedelta, timezone

from db import connect

RETENTION_DAYS = int(os.environ.get("DESKSWARM_AUDIT_RETENTION_DAYS", "90"))

# Routes worth no line: polling and health checks would drown everything else.
IGNORED_PATH_PREFIXES = ("/partials/", "/health", "/static/")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def init(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            at TEXT NOT NULL,
            actor TEXT NOT NULL,          -- 'dashboard' or 'share:<label>'
            source_ip TEXT,
            action TEXT NOT NULL,         -- 'POST /api/v1/computers/3/exec'
            target TEXT,                  -- machine name where known
            detail TEXT,                  -- short, never file or clipboard bodies
            status INTEGER,               -- HTTP status
            ok INTEGER NOT NULL DEFAULT 1
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS audit_at ON audit (at DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS audit_target ON audit (target)")


def record(action: str, *, actor: str = "dashboard", source_ip: str | None = None,
           target: str | None = None, detail=None, status: int | None = None,
           ok: bool = True) -> None:
    if detail is not None and not isinstance(detail, str):
        detail = json.dumps(detail, ensure_ascii=False)[:2000]
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO audit (at, actor, source_ip, action, target, detail, status, ok) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (now_iso(), actor, source_ip, action, target,
             (detail or "")[:2000] or None, status, 1 if ok else 0),
        )
        conn.commit()
    finally:
        conn.close()


def should_record(method: str, path: str) -> bool:
    if method in ("GET", "HEAD", "OPTIONS"):
        return False
    return not any(path.startswith(p) for p in IGNORED_PATH_PREFIXES)


def prune(conn) -> int:
    """Drop entries past the retention window. An audit log that grows without
    limit eventually becomes the reason the disk filled."""
    if RETENTION_DAYS <= 0:
        return 0
    cutoff = (datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS))
    cur = conn.execute("DELETE FROM audit WHERE at < ?",
                       (cutoff.isoformat(timespec="seconds"),))
    conn.commit()
    return cur.rowcount


def recent(conn, limit: int = 100, page: int = 1, target: str | None = None,
           actor: str | None = None) -> tuple[list[dict], int]:
    where, params = [], []
    if target:
        where.append("target = ?")
        params.append(target)
    if actor:
        where.append("actor LIKE ?")
        params.append(actor + "%")
    clause = (" WHERE " + " AND ".join(where)) if where else ""

    total = conn.execute(f"SELECT COUNT(*) AS n FROM audit{clause}", params).fetchone()["n"]
    pages = max(1, -(-total // limit))
    page = min(max(1, page), pages)
    rows = conn.execute(
        f"SELECT * FROM audit{clause} ORDER BY id DESC LIMIT ? OFFSET ?",
        (*params, limit, (page - 1) * limit),
    ).fetchall()
    return [dict(r) for r in rows], pages
