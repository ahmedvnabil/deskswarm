"""Freezing a provisioned machine into an image, and the wall's stills."""

from flask import Blueprint, Response, jsonify, request

import fleet
import guards
from db import connect
from machines import computer_view, get_computer, now_iso
from screens import bridge_screenshot
from security import require_token
from settings import SHOT_TTL


bp = Blueprint("snapshots", __name__)


@bp.route("/api/v1/snapshots")
def api_snapshots_list():
    conn = connect()
    rows = [dict(r) for r in conn.execute("SELECT * FROM snapshots ORDER BY id DESC")]
    conn.close()
    return jsonify({"ok": True, "data": rows, "error": None})


@bp.route("/api/v1/computers/<int:comp_id>/snapshot", methods=["POST"])
@require_token
def api_computer_snapshot(comp_id: int):
    """Freeze a provisioned machine into a reusable image."""
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404

    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "data": None, "error": "name is required"}), 400

    ok, msg = guards.check_disk()
    if not ok:
        return jsonify({"ok": False, "data": None, "error": msg}), 507

    conn = connect()
    if conn.execute("SELECT 1 FROM snapshots WHERE name = ?", (name,)).fetchone():
        conn.close()
        return jsonify({"ok": False, "data": None, "error": f"snapshot '{name}' already exists"}), 409

    try:
        image = fleet.snapshot_computer(comp["slug"], fleet.slugify(name))
    except Exception as exc:  # noqa: BLE001
        conn.close()
        return jsonify({"ok": False, "data": None, "error": f"snapshot failed: {exc}"}), 500

    conn.execute(
        "INSERT INTO snapshots (name, image, source, created_at) VALUES (?,?,?,?)",
        (name, image, comp["name"], now_iso()),
    )
    conn.commit()
    row = dict(conn.execute("SELECT * FROM snapshots WHERE name = ?", (name,)).fetchone())
    conn.close()
    return jsonify({"ok": True, "data": row, "error": None}), 201


@bp.route("/api/v1/snapshots/<int:snap_id>", methods=["DELETE"])
@require_token
def api_snapshot_delete(snap_id: int):
    conn = connect()
    row = conn.execute("SELECT * FROM snapshots WHERE id = ?", (snap_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    in_use = conn.execute("SELECT COUNT(*) c FROM computers WHERE image = ?", (row["image"],)).fetchone()["c"]
    conn.execute("DELETE FROM snapshots WHERE id = ?", (snap_id,))
    conn.commit()
    conn.close()
    # Only drop the image when nothing is running off it.
    if not in_use:
        try:
            fleet.remove_image(row["image"])
        except Exception:  # noqa: BLE001
            pass
    return jsonify({"ok": True, "data": {"id": snap_id, "removed": True,
                                         "image_kept": bool(in_use)}, "error": None})


@bp.route("/api/v1/computers/<int:comp_id>/screenshot")
def api_computer_screenshot(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    # A sleeping machine has no screen to capture. Saying so immediately beats
    # spending the bridge's full 12s timeout on every tile, every refresh.
    try:
        if fleet.container_state(comp["slug"]).get("desktop_state") == "exited":
            return jsonify({"ok": False, "data": None, "error": "sleeping"}), 503
    except Exception:  # noqa: BLE001
        pass
    png = bridge_screenshot(computer_view(comp, with_state=False))
    if png is None:
        return jsonify({"ok": False, "data": None, "error": "screen unavailable"}), 503
    return Response(png, mimetype="image/png",
                    headers={"Cache-Control": f"max-age={int(SHOT_TTL)}"})
