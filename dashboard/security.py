"""Who may change things, and from where.

The hooks are plain functions; app.py attaches them. Registering them
here with a decorator would mean importing the app object, and the app
object needs these — a cycle for no gain.

The cross-site check and the audit hook are two halves of the same concern —
one refuses requests the user did not make, the other records the ones that
got through — so they live together and are attached to the app by app.py.
"""

from functools import wraps
from urllib.parse import urlparse

from flask import g, jsonify, request

import audit
from settings import DASHBOARD_TOKEN


SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def block_cross_site():
    """Reject state-changing requests that a *browser* sends from another site.

    Without this, any page the user visits could auto-submit a plain HTML form
    at this dashboard. Form posts are "simple requests", so they are sent with
    no CORS preflight to stop them — and POST /computers/<id>/exec runs a shell
    command as root inside a machine. That is remote code execution triggered
    by nothing more than visiting a web page.

    Browsers always attach Origin to a cross-site state-changing request, so
    rejecting a *present but foreign* Origin closes the hole. Non-browser
    clients (curl, n8n, cron) send no Origin at all and keep working; they are
    not a CSRF vector because no one else controls them.
    """
    if request.method in SAFE_METHODS:
        return None
    source = request.headers.get("Origin") or request.headers.get("Referer")
    if not source:
        return None
    if urlparse(source).netloc != request.host:
        return jsonify({"ok": False, "data": None,
                        "error": "cross-site request blocked"}), 403
    return None


def write_audit(response):
    """Record every state-changing request, once, in one place.

    Deliberately a hook rather than a call inside each handler: a log you have
    to remember to write is a log with holes, and the holes land in whichever
    endpoint was added last — usually the interesting one.

    Handlers add context by setting `g.audit_target` / `g.audit_detail`. What
    they must not put there is content: the shell command is recorded because
    that is the whole point, but clipboard text and file bodies are only ever
    counted.
    """
    try:
        if audit.should_record(request.method, request.path):
            audit.record(
                f"{request.method} {request.path}",
                actor=getattr(g, "actor", "dashboard"),
                source_ip=request.headers.get("X-Forwarded-For",
                                              request.remote_addr or "").split(",")[0].strip(),
                target=getattr(g, "audit_target", None),
                detail=getattr(g, "audit_detail", None),
                status=response.status_code,
                ok=response.status_code < 400,
            )
    except Exception:  # noqa: BLE001
        pass          # an audit failure must never break the request itself
    return response


def require_token(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not DASHBOARD_TOKEN:
            return fn(*args, **kwargs)
        supplied = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if supplied != DASHBOARD_TOKEN:
            return jsonify({"ok": False, "data": None, "error": "unauthorized"}), 401
        return fn(*args, **kwargs)
    return wrapper
