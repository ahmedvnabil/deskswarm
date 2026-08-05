"""Dispatching work to machines, and reading back what happened."""

import csv
import io
import os
import signal
import threading
from flask import Blueprint, Response, jsonify, render_template, request

import fleet
from machines import get_computer_by_name, list_computers
from security import require_token
from settings import PAGE_SIZE
from tasks import build_analytics, compute_duration_seconds, create_task_row, dispatch_task, get_task_row, run_task_worker, update_task_row

from db import get_db


bp = Blueprint("tasks", __name__)


@bp.route("/partials/tasks")
def partial_tasks():
    desktop = (request.args.get("desktop") or "").strip()
    status = (request.args.get("status") or "").strip().upper()
    try:
        page = max(1, int(request.args.get("page") or 1))
    except ValueError:
        page = 1

    where, params = [], []
    if desktop:
        where.append("desktop = ?")
        params.append(desktop)
    if status == "ACTIVE":
        where.append("status IN ('PENDING', 'RUNNING')")
    elif status in ("COMPLETED", "FAILED", "CANCELLED"):
        where.append("status = ?")
        params.append(status)
    clause = (" WHERE " + " AND ".join(where)) if where else ""

    db = get_db()
    total = db.execute(f"SELECT COUNT(*) c FROM tasks{clause}", params).fetchone()["c"]
    pages = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
    page = min(page, pages)
    rows = [dict(r) for r in db.execute(
        f"SELECT * FROM tasks{clause} ORDER BY id DESC LIMIT ? OFFSET ?",
        (*params, PAGE_SIZE, (page - 1) * PAGE_SIZE),
    ).fetchall()]
    for r in rows:
        r["duration_seconds"] = compute_duration_seconds(r)

    return render_template(
        "_tasks.html",
        tasks=rows,
        names=[c["name"] for c in list_computers()],
        sel_desktop=desktop,
        sel_status=status,
        page=page, pages=pages, total=total,
    )


@bp.route("/partials/analytics")
def partial_analytics():
    return render_template("_analytics.html", analytics=build_analytics())


@bp.route("/api/v1/analytics")
def api_analytics():
    return jsonify({"ok": True, "data": build_analytics(), "error": None})


@bp.route("/api/v1/tasks", methods=["GET"])
def api_tasks_list():
    db = get_db()
    rows = [dict(r) for r in db.execute("SELECT * FROM tasks ORDER BY id DESC LIMIT 100").fetchall()]
    for r in rows:
        r["duration_seconds"] = compute_duration_seconds(r)
    return jsonify({"ok": True, "data": rows, "error": None})


@bp.route("/api/v1/tasks/export.csv")
def api_tasks_export():
    db = get_db()
    rows = db.execute("SELECT * FROM tasks ORDER BY id DESC").fetchall()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "desktop", "description", "status", "result_text", "cost_usd",
                     "duration_seconds", "error", "created_at", "updated_at"])
    for r in rows:
        d = dict(r)
        writer.writerow([d["id"], d["desktop"], d["description"], d["status"],
                         d.get("result_text") or "", d.get("cost_usd") or "",
                         compute_duration_seconds(d) or "", d.get("error") or "",
                         d["created_at"], d["updated_at"]])
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=deskswarm-tasks.csv"})


@bp.route("/api/v1/tasks/<int:task_id>", methods=["GET"])
def api_task_detail(task_id: int):
    row = get_task_row(task_id)
    if not row:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    row["duration_seconds"] = compute_duration_seconds(row)
    return jsonify({"ok": True, "data": row, "error": None})


@bp.route("/api/v1/tasks", methods=["POST"])
@require_token
def api_tasks_create():
    payload = request.get_json(silent=True) or {}
    description = (payload.get("description") or "").strip()
    target = payload.get("desktop") or "all"

    if not description:
        return jsonify({"ok": False, "data": None, "error": "description is required"}), 400
    try:
        created_ids = dispatch_task(target, description)
    except ValueError as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400

    return jsonify({"ok": True, "data": {"task_ids": created_ids}, "error": None}), 201


@bp.route("/api/v1/tasks/<int:task_id>/cancel", methods=["POST"])
@require_token
def api_task_cancel(task_id: int):
    row = get_task_row(task_id)
    if not row:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    if row["status"] not in ("PENDING", "RUNNING"):
        return jsonify({"ok": False, "data": None, "error": f"task is {row['status']}, cannot cancel"}), 400
    update_task_row(task_id, status="CANCELLED", current_action=None, error="cancelled by user")
    if row.get("pid"):
        try:
            os.kill(row["pid"], signal.SIGTERM)
        except ProcessLookupError:
            pass
    return jsonify({"ok": True, "data": {"id": task_id, "status": "CANCELLED"}, "error": None})


@bp.route("/api/v1/tasks/<int:task_id>/retry", methods=["POST"])
@require_token
def api_task_retry(task_id: int):
    row = get_task_row(task_id)
    if not row:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    comp = get_computer_by_name(row["desktop"])
    if not comp:
        return jsonify({"ok": False, "data": None, "error": f"computer '{row['desktop']}' no longer exists"}), 400

    new_id = create_task_row(comp["name"], row["description"])
    threading.Thread(
        target=run_task_worker,
        args=(new_id, fleet.bridge_container_name(comp["slug"]), 8000, row["description"]),
        daemon=True,
    ).start()
    return jsonify({"ok": True, "data": {"task_id": new_id}, "error": None}), 201
