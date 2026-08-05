"""Health, the page itself, the guards panel and space reclaim."""

from flask import Blueprint, jsonify, render_template

import fleet
import guards
from db import connect
from machines import budgeted_machine_count, list_computers
from security import require_token


bp = Blueprint("system", __name__)


@bp.route("/health")
def health():
    return jsonify({"status": "ok"})


@bp.route("/")
def index():
    return render_template("index.html", computers=list_computers())


@bp.route("/api/v1/guards")
def api_guards():
    conn = connect()
    data = guards.status(conn, budgeted_machine_count())
    conn.close()
    return jsonify({"ok": True, "data": data, "error": None})


@bp.route("/partials/guards")
def partial_guards():
    conn = connect()
    data = guards.status(conn, budgeted_machine_count())
    conn.close()
    return render_template("_guards.html", g=data)


@bp.route("/api/v1/maintenance/prune", methods=["POST"])
@require_token
def api_prune():
    """Reclaim the space Docker holds but no longer needs.

    Only build cache and dangling layers — never a tagged image, so a snapshot
    someone is relying on can't vanish because the disk got tight.
    """
    before = guards.disk_free_gb()
    reclaimed = 0
    try:
        reclaimed += (fleet.client().api.prune_builds() or {}).get("SpaceReclaimed", 0)
        reclaimed += (fleet.client().images.prune(filters={"dangling": True}) or {}).get(
            "SpaceReclaimed", 0)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": f"prune failed: {exc}"}), 500
    return jsonify({"ok": True, "error": None, "data": {
        "reclaimed_gb": round(reclaimed / 1e9, 2),
        "disk_free_gb_before": before,
        "disk_free_gb_after": guards.disk_free_gb(),
    }})
