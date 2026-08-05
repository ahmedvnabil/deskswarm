"""Getting files onto a machine, and off it."""

import os

from flask import Blueprint, Response, jsonify, render_template, request

import fleet
from machines import get_computer
from security import require_token
from settings import MAX_UPLOAD_MB


bp = Blueprint("files", __name__)


@bp.route("/api/v1/computers/<int:comp_id>/files")
def api_files_list(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    rel = request.args.get("path", "")
    try:
        entries = fleet.list_home(comp["slug"], rel)
    except fleet.PathOutsideHome as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400
    except FileNotFoundError:
        return jsonify({"ok": False, "data": None, "error": f"no such folder: {rel}"}), 404
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 500
    return jsonify({"ok": True, "error": None,
                    "data": {"path": rel, "entries": entries}})


@bp.route("/api/v1/computers/<int:comp_id>/files", methods=["POST"])
@require_token
def api_files_upload(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        return jsonify({"ok": False, "data": None, "error": "no file supplied"}), 400

    data = uploaded.read()
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        return jsonify({"ok": False, "data": None,
                        "error": f"file is larger than {MAX_UPLOAD_MB} MB"}), 413

    # Land on the Desktop by default: the point is that you can see it.
    rel_dir = request.form.get("path") or "Desktop"
    name = os.path.basename(uploaded.filename)
    try:
        path = fleet.upload_to_home(comp["slug"], rel_dir, name, data)
    except fleet.PathOutsideHome as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 500
    return jsonify({"ok": True, "error": None,
                    "data": {"path": path, "bytes": len(data)}}), 201


@bp.route("/api/v1/computers/<int:comp_id>/files/download")
def api_files_download(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    rel = request.args.get("path", "")
    if not rel:
        return jsonify({"ok": False, "data": None, "error": "path is required"}), 400
    try:
        blob, name, _ = fleet.download_from_home(comp["slug"], rel)
    except fleet.PathOutsideHome as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 404
    return Response(blob, mimetype="application/octet-stream", headers={
        "Content-Disposition": f'attachment; filename="{name}"'})


@bp.route("/partials/computers/<int:comp_id>/files")
def partial_files(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return "<div class='text-red-400 text-sm'>not found</div>", 404
    rel = request.args.get("path", "")
    try:
        entries = fleet.list_home(comp["slug"], rel)
        error = None
    except Exception as exc:  # noqa: BLE001
        entries, error = [], str(exc)
    parent = os.path.dirname(rel.rstrip("/")) if rel else None
    return render_template("_files.html", comp=comp, entries=entries, path=rel,
                           parent=parent, error=error, max_mb=MAX_UPLOAD_MB)
