"""Repeating a task on a timer."""

import re
from flask import Blueprint, jsonify, render_template, request

from db import connect
from machines import get_computer_by_name, now_iso
from scheduler import compute_next_run
from security import require_token


bp = Blueprint("schedules", __name__)


@bp.route("/partials/schedules")
def partial_schedules():
    conn = connect()
    rows = [dict(r) for r in conn.execute("SELECT * FROM schedules ORDER BY id DESC")]
    conn.close()
    return render_template("_schedules.html", schedules=rows)


@bp.route("/api/v1/schedules")
def api_schedules_list():
    conn = connect()
    rows = [dict(r) for r in conn.execute("SELECT * FROM schedules ORDER BY id DESC")]
    conn.close()
    return jsonify({"ok": True, "data": rows, "error": None})


@bp.route("/api/v1/schedules", methods=["POST"])
@require_token
def api_schedules_create():
    payload = request.get_json(silent=True) or {}
    description = (payload.get("description") or "").strip()
    desktop = (payload.get("desktop") or "all").strip()
    kind = (payload.get("kind") or "interval").strip()

    if not description:
        return jsonify({"ok": False, "data": None, "error": "description is required"}), 400
    if kind not in ("interval", "daily"):
        return jsonify({"ok": False, "data": None, "error": "kind must be 'interval' or 'daily'"}), 400

    every_minutes, at_time = None, None
    if kind == "interval":
        try:
            every_minutes = int(payload.get("every_minutes") or 60)
        except ValueError:
            return jsonify({"ok": False, "data": None, "error": "every_minutes must be a number"}), 400
        if every_minutes < 1:
            return jsonify({"ok": False, "data": None, "error": "every_minutes must be >= 1"}), 400
    else:
        at_time = (payload.get("at_time") or "").strip()
        if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", at_time):
            return jsonify({"ok": False, "data": None, "error": "at_time must be HH:MM (24h UTC)"}), 400

    if desktop != "all" and not get_computer_by_name(desktop):
        return jsonify({"ok": False, "data": None, "error": f"unknown computer '{desktop}'"}), 400

    conn = connect()
    cur = conn.execute(
        "INSERT INTO schedules (desktop, description, kind, every_minutes, at_time, "
        "enabled, next_run_at, created_at) VALUES (?,?,?,?,?,1,?,?)",
        (desktop, description, kind, every_minutes, at_time,
         compute_next_run(kind, every_minutes, at_time), now_iso()),
    )
    conn.commit()
    row = dict(conn.execute("SELECT * FROM schedules WHERE id = ?", (cur.lastrowid,)).fetchone())
    conn.close()
    return jsonify({"ok": True, "data": row, "error": None}), 201


@bp.route("/api/v1/schedules/<int:sched_id>", methods=["PATCH"])
@require_token
def api_schedule_toggle(sched_id: int):
    payload = request.get_json(silent=True) or {}
    conn = connect()
    row = conn.execute("SELECT * FROM schedules WHERE id = ?", (sched_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    enabled = 1 if str(payload.get("enabled", "1")).lower() in ("1", "true", "yes") else 0
    nxt = compute_next_run(row["kind"], row["every_minutes"], row["at_time"]) if enabled else row["next_run_at"]
    conn.execute("UPDATE schedules SET enabled = ?, next_run_at = ? WHERE id = ?", (enabled, nxt, sched_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "data": {"id": sched_id, "enabled": bool(enabled)}, "error": None})


@bp.route("/api/v1/schedules/<int:sched_id>", methods=["DELETE"])
@require_token
def api_schedule_delete(sched_id: int):
    conn = connect()
    row = conn.execute("SELECT 1 FROM schedules WHERE id = ?", (sched_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    conn.execute("DELETE FROM schedules WHERE id = ?", (sched_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "data": {"id": sched_id, "removed": True}, "error": None})
