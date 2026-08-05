"""Links that reach one machine, and the guest page behind them."""

from flask import Blueprint, Response, abort, g, jsonify, render_template, request

import audit
import fleet
import shares
from db import connect
from machines import computer_view, get_computer, list_computers
from screens import bridge_screenshot
from security import require_token
from settings import SHOT_TTL


bp = Blueprint("shares", __name__)


def share_base_url() -> str:
    return request.host_url.rstrip("/")


def share_view(row: dict, comp_name: str | None = None) -> dict:
    out = dict(row)
    out.pop("token_hash", None)
    out["status"] = shares.status(row)
    out["url"] = f"{share_base_url()}/s/{row['token']}"
    if comp_name:
        out["computer"] = comp_name
    return out


@bp.route("/api/v1/shares", methods=["GET"])
def api_shares_list():
    conn = connect()
    names = {c["id"]: c["name"] for c in list_computers()}
    rows = [share_view(r, names.get(r["computer_id"])) for r in shares.listing(conn)]
    conn.close()
    return jsonify({"ok": True, "data": rows, "error": None})


@bp.route("/api/v1/computers/<int:comp_id>/shares", methods=["POST"])
@require_token
def api_share_create(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    payload = request.get_json(silent=True) or {}
    conn = connect()
    try:
        row = shares.create(conn, comp_id,
                            label=payload.get("label", ""),
                            mode=(payload.get("mode") or "watch").strip(),
                            hours=payload.get("hours"))
    except ValueError as exc:
        conn.close()
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400
    conn.close()
    g.audit_detail = f"{row['mode']} share '{row['label']}' until {row['expires_at']}"
    return jsonify({"ok": True, "data": share_view(row, comp["name"]), "error": None}), 201


@bp.route("/api/v1/shares/<int:share_id>", methods=["DELETE"])
@require_token
def api_share_revoke(share_id: int):
    conn = connect()
    row = conn.execute("SELECT * FROM shares WHERE id = ?", (share_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    revoked = shares.revoke(conn, share_id)
    conn.close()
    g.audit_detail = f"share '{row['label']}' ({row['mode']})"
    return jsonify({"ok": True, "error": None, "data": {
        "id": share_id, "revoked": revoked,
        # Being straight about what revoking a control share does and doesn't
        # do matters more than sounding reassuring.
        "note": ("the guest's browser already holds this machine's screen "
                 "password — rotate it to retract access completely")
        if row["mode"] == "control" else None,
    }})


@bp.route("/api/v1/computers/<int:comp_id>/rotate-password", methods=["POST"])
@require_token
def api_rotate_password(comp_id: int):
    """Give the machine a new screen password and restart it.

    This is the hard revoke behind a control share: anyone holding the old
    noVNC URL is out, including a guest who saved it.
    """
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    password = fleet.random_vnc_password()
    try:
        fleet.destroy_computer(comp["slug"], keep_home=True)
        fleet.create_computer(comp["slug"], comp["novnc_port"], password, image=comp["image"])
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None,
                        "error": f"failed to rotate: {exc}"}), 500
    conn = connect()
    conn.execute("UPDATE computers SET vnc_password = ? WHERE id = ?", (password, comp_id))
    conn.execute("UPDATE shares SET revoked = 1 WHERE computer_id = ? AND mode = 'control'",
                 (comp_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "data": {"id": comp_id, "rotated": True}, "error": None})


def current_share():
    """The live share behind this request, or None."""
    token = request.view_args.get("token") if request.view_args else None
    conn = connect()
    row = shares.resolve(conn, token or "")
    if row:
        shares.note_use(conn, row["id"], request.remote_addr)
        g.actor = f"share:{row['label']}"
    conn.close()
    return row


@bp.route("/s/<token>")
def share_page(token: str):
    """The page a guest sees. One machine, nothing else, no dashboard."""
    row = current_share()
    if not row:
        return render_template("share_gone.html"), 404
    comp = get_computer(row["computer_id"])
    if not comp:
        return render_template("share_gone.html"), 404
    view = computer_view(comp)
    audit.record(f"GET /s/<token> ({row['mode']})", actor=f"share:{row['label']}",
                 source_ip=request.remote_addr, target=comp["name"],
                 detail="opened the share page", status=200)
    return render_template("share.html", comp=comp, view=view, share=row, token=token)


@bp.route("/s/<token>/screen.png")
def share_screen(token: str):
    """The screen, served through the share rather than the machine's port —
    which is what makes a `watch` share fully revocable."""
    row = current_share()
    if not row:
        abort(404)
    comp = get_computer(row["computer_id"])
    if not comp:
        abort(404)
    if not fleet.is_running(comp["slug"]):
        abort(503)
    png = bridge_screenshot(computer_view(comp, with_state=False))
    if png is None:
        abort(503)
    return Response(png, mimetype="image/png",
                    headers={"Cache-Control": f"max-age={int(SHOT_TTL)}"})
