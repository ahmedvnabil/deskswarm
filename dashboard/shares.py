"""Handing one machine to someone else, without handing over the fleet.

Until now the only way to let a colleague look at a machine was to give them
the dashboard — which is every machine, a root shell on each, and the Docker
socket behind it. A share is a link to exactly one machine, with an expiry
and a revoke.

Two modes, and the difference between them is worth being precise about:

  watch    the page shows the machine's screen as a refreshing still, served
           through the share token. Nothing about the machine is exposed:
           revoking is complete and immediate.

  control  the page embeds the machine's own noVNC, so the guest gets
           keyboard and mouse. That means their browser is handed the
           machine's VNC password, and they can save the direct URL.
           Revoking closes the share page — it cannot reach into their
           browser and take back what they already have. Rotating the
           machine's screen password is what actually retracts it, and the
           dashboard offers that as a separate action.

Tokens are compared with compare_digest and looked up by their hash, so a
timing difference doesn't leak them one character at a time.
"""

import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone

MODES = ("watch", "control")
DEFAULT_HOURS = int(os.environ.get("DESKSWARM_SHARE_DEFAULT_HOURS", "24"))
MAX_HOURS = int(os.environ.get("DESKSWARM_SHARE_MAX_HOURS", "720"))   # 30 days


def now() -> datetime:
    return datetime.now(timezone.utc)


def init(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS shares (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            computer_id INTEGER NOT NULL,
            token TEXT NOT NULL UNIQUE,
            token_hash TEXT NOT NULL UNIQUE,
            label TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'watch',
            expires_at TEXT NOT NULL,
            revoked INTEGER NOT NULL DEFAULT 0,
            uses INTEGER NOT NULL DEFAULT 0,
            last_used_at TEXT,
            last_used_ip TEXT,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS shares_hash ON shares (token_hash)")


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(32)


def create(conn, computer_id: int, label: str, mode: str = "watch",
           hours: int | None = None) -> dict:
    if mode not in MODES:
        raise ValueError(f"mode must be one of {', '.join(MODES)}")
    hours = DEFAULT_HOURS if hours is None else int(hours)
    if hours < 1 or hours > MAX_HOURS:
        raise ValueError(f"expiry must be between 1 and {MAX_HOURS} hours")
    label = (label or "").strip() or "guest"

    token = new_token()
    expires = now() + timedelta(hours=hours)
    conn.execute(
        "INSERT INTO shares (computer_id, token, token_hash, label, mode, "
        "expires_at, created_at) VALUES (?,?,?,?,?,?,?)",
        (computer_id, token, hash_token(token), label, mode,
         expires.isoformat(timespec="seconds"), now().isoformat(timespec="seconds")),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM shares WHERE token = ?", (token,)).fetchone()
    return dict(row)


def resolve(conn, token: str) -> dict | None:
    """Find a live share for this token, or None.

    Looked up by hash so the query is a single indexed comparison, then
    confirmed with compare_digest — an ordinary `==` on the secret is where
    timing leaks come from.
    """
    if not token:
        return None
    row = conn.execute("SELECT * FROM shares WHERE token_hash = ?",
                       (hash_token(token),)).fetchone()
    if not row:
        return None
    if not secrets.compare_digest(row["token"], token):
        return None
    if row["revoked"]:
        return None
    try:
        if datetime.fromisoformat(row["expires_at"]) <= now():
            return None
    except ValueError:
        return None
    return dict(row)


def note_use(conn, share_id: int, ip: str | None) -> None:
    conn.execute(
        "UPDATE shares SET uses = uses + 1, last_used_at = ?, last_used_ip = ? WHERE id = ?",
        (now().isoformat(timespec="seconds"), ip, share_id),
    )
    conn.commit()


def revoke(conn, share_id: int) -> bool:
    cur = conn.execute("UPDATE shares SET revoked = 1 WHERE id = ? AND revoked = 0",
                       (share_id,))
    conn.commit()
    return cur.rowcount == 1


def status(row: dict) -> str:
    if row["revoked"]:
        return "revoked"
    try:
        if datetime.fromisoformat(row["expires_at"]) <= now():
            return "expired"
    except ValueError:
        return "expired"
    return "live"


def listing(conn, computer_id: int | None = None) -> list[dict]:
    sql = "SELECT * FROM shares"
    params: tuple = ()
    if computer_id is not None:
        sql += " WHERE computer_id = ?"
        params = (computer_id,)
    sql += " ORDER BY id DESC"
    rows = []
    for r in conn.execute(sql, params):
        d = dict(r)
        d["status"] = status(d)
        rows.append(d)
    return rows


def purge_expired(conn, keep_days: int = 30) -> int:
    """Forget shares that stopped working a while ago, so the table doesn't
    become an ever-growing list of dead links."""
    cutoff = (now() - timedelta(days=keep_days)).isoformat(timespec="seconds")
    cur = conn.execute("DELETE FROM shares WHERE expires_at < ?", (cutoff,))
    conn.commit()
    return cur.rowcount
