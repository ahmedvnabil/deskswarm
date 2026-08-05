"""Archiving a machine's home directory, and putting it back."""

import os
import tarfile
import tempfile
from pathlib import Path
from flask import Blueprint, Response, g, jsonify, render_template, request

import backups
import guards
from machines import get_computer
from security import require_token


bp = Blueprint("backups", __name__)


def _backup_or_404(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return None, (jsonify({"ok": False, "data": None, "error": "not found"}), 404)
    return comp, None


@bp.route("/api/v1/computers/<int:comp_id>/backups", methods=["GET"])
def api_backups_list(comp_id: int):
    comp, err = _backup_or_404(comp_id)
    if err:
        return err
    return jsonify({"ok": True, "data": backups.listing(comp["slug"]), "error": None})


@bp.route("/api/v1/computers/<int:comp_id>/backups", methods=["POST"])
@require_token
def api_backup_create(comp_id: int):
    comp, err = _backup_or_404(comp_id)
    if err:
        return err
    ok, msg = guards.check_disk()
    if not ok:
        return jsonify({"ok": False, "data": None, "error": msg}), 507
    try:
        meta = backups.create(comp["slug"])
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": f"backup failed: {exc}"}), 500
    g.audit_detail = f"{meta['name']} ({meta['bytes']} bytes)"
    return jsonify({"ok": True, "data": meta, "error": None}), 201


@bp.route("/api/v1/computers/<int:comp_id>/backups/<name>", methods=["GET"])
def api_backup_download(comp_id: int, name: str):
    comp, err = _backup_or_404(comp_id)
    if err:
        return err
    try:
        path = backups.backup_path(comp["slug"], name)
    except backups.BadBackupName as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400
    if not path.is_file():
        return jsonify({"ok": False, "data": None, "error": "no such backup"}), 404
    return Response(
        _stream_file(path), mimetype="application/gzip",
        headers={"Content-Disposition": f'attachment; filename="{comp["slug"]}-{name}"',
                 "Content-Length": str(path.stat().st_size)})


def _stream_file(path, chunk: int = 1024 * 1024):
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                return
            yield block


@bp.route("/api/v1/computers/<int:comp_id>/backups/<name>", methods=["DELETE"])
@require_token
def api_backup_delete(comp_id: int, name: str):
    comp, err = _backup_or_404(comp_id)
    if err:
        return err
    try:
        removed = backups.remove(comp["slug"], name)
    except backups.BadBackupName as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400
    if not removed:
        return jsonify({"ok": False, "data": None, "error": "no such backup"}), 404
    g.audit_detail = name
    return jsonify({"ok": True, "data": {"removed": name}, "error": None})


@bp.route("/api/v1/computers/<int:comp_id>/restore", methods=["POST"])
@require_token
def api_backup_restore(comp_id: int):
    """Put a backup back. The machine is stopped for the duration and
    restarted afterwards if it was running."""
    comp, err = _backup_or_404(comp_id)
    if err:
        return err
    payload = request.get_json(silent=True) or {}
    name = (payload.get("backup") or "").strip()
    source_slug = (payload.get("from") or comp["slug"]).strip()
    if not name:
        return jsonify({"ok": False, "data": None, "error": "backup is required"}), 400
    try:
        path = backups.backup_path(source_slug, name)
    except backups.BadBackupName as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400
    if not path.is_file():
        return jsonify({"ok": False, "data": None, "error": "no such backup"}), 404

    g.audit_detail = f"from {source_slug}/{name}"
    try:
        result = backups.restore(comp["slug"], path)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": f"restore failed: {exc}"}), 500
    return jsonify({"ok": True, "data": result, "error": None})


@bp.route("/api/v1/computers/<int:comp_id>/restore/upload", methods=["POST"])
@require_token
def api_backup_restore_upload(comp_id: int):
    """Restore from a file the user hands us, rather than one we made.

    This is how a machine is rebuilt on a different host — and why
    `backups.sanitise` refuses members that climb out of the home directory:
    from here the archive is entirely untrusted input.
    """
    comp, err = _backup_or_404(comp_id)
    if err:
        return err
    upload = request.files.get("file")
    if not upload or not upload.filename:
        return jsonify({"ok": False, "data": None, "error": "file is required"}), 400

    tmp = Path(tempfile.gettempdir()) / f"deskswarm-restore-{comp['slug']}-{os.getpid()}.tar.gz"
    g.audit_detail = f"uploaded {upload.filename}"
    try:
        upload.save(tmp)
        result = backups.restore(comp["slug"], tmp)
    except tarfile.TarError:
        return jsonify({"ok": False, "data": None,
                        "error": "that file is not a readable .tar.gz backup"}), 400
    except OSError as exc:
        return jsonify({"ok": False, "data": None, "error": f"restore failed: {exc}"}), 500
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": f"restore failed: {exc}"}), 500
    finally:
        tmp.unlink(missing_ok=True)
    return jsonify({"ok": True, "data": result, "error": None})


@bp.route("/partials/computers/<int:comp_id>/backups")
def partial_backups(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return "<div class='text-red-400 text-sm'>not found</div>", 404
    return render_template("_backups.html", comp=comp,
                           rows=backups.listing(comp["slug"]),
                           keep=backups.KEEP_PER_MACHINE,
                           daily_at=backups.DAILY_AT)
