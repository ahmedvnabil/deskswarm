"""Adding, inspecting, driving and removing machines."""

import time

from flask import Blueprint, g, jsonify, render_template, request

import fleet
import guards
from db import connect
from machines import (budgeted_machine_count, computer_views, create_one_computer,
                      expand_names, get_computer, list_computers, touch_active,
                      wake_and_wait)
from security import require_token
from settings import MAX_CLIPBOARD_KB, SHOT_TTL
from tasks import active_task_by_computer

bp = Blueprint("machines", __name__)


@bp.route("/partials/fleet")
def partial_fleet():
    busy = active_task_by_computer()
    computers = computer_views(list_computers())
    for view in computers:
        view["active_task"] = busy.get(view["name"])
    return render_template("_fleet.html", computers=computers,
                           shot_token=int(time.time() // SHOT_TTL))


@bp.route("/api/v1/computers", methods=["GET"])
def api_computers_list():
    return jsonify({"ok": True, "data": computer_views(list_computers()), "error": None})


@bp.route("/api/v1/computers", methods=["POST"])
@require_token
def api_computers_create():
    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or "").strip()
    snapshot_name = (payload.get("snapshot") or "").strip()
    if not name:
        return jsonify({"ok": False, "data": None, "error": "name is required"}), 400

    image = None
    if snapshot_name:
        conn = connect()
        snap = conn.execute("SELECT * FROM snapshots WHERE name = ?", (snapshot_name,)).fetchone()
        conn.close()
        if not snap:
            return jsonify({"ok": False, "data": None,
                            "error": f"unknown snapshot '{snapshot_name}'"}), 400
        image = snap["image"]

    try:
        names = expand_names(name)
    except ValueError as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 400

    fleet_size = budgeted_machine_count()
    for ok, msg in (guards.check_memory(len(names), fleet_size), guards.check_disk()):
        if not ok:
            return jsonify({"ok": False, "data": None, "error": msg}), 507

    conn = connect()
    created, errors = [], []
    for n in names:
        try:
            created.append(create_one_computer(conn, n, image))
        except ValueError as exc:
            errors.append({"name": n, "error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            errors.append({"name": n, "error": f"failed to start containers: {exc}"})
    conn.close()

    if not created:
        msg = errors[0]["error"] if errors else "nothing created"
        code = 409 if errors and "already exists" in errors[0]["error"] else 500
        return jsonify({"ok": False, "data": {"errors": errors}, "error": msg}), code

    # Creation is the one mutation with no machine to look up beforehand, so
    # the audit target has to be named here rather than by get_computer.
    g.audit_target = names[0] if len(names) == 1 else None
    g.audit_detail = (f"created {len(created)}" +
                      (f", {len(errors)} failed" if errors else "") +
                      (f" ({', '.join(c['name'] for c in created[:8])})"
                       if len(names) > 1 else ""))

    # Single-name requests keep returning the bare object they always did.
    data = created[0] if len(names) == 1 else {"created": created, "errors": errors}
    return jsonify({"ok": True, "data": data, "error": None}), 201


@bp.route("/api/v1/computers/<int:comp_id>", methods=["PATCH"])
@require_token
def api_computers_rename(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    payload = request.get_json(silent=True) or {}

    # Same endpoint also flips the boolean flags, which carry no name.
    for field in ("reserved", "no_suspend"):
        if field in payload and "name" not in payload:
            flag = 1 if str(payload[field]).lower() in ("1", "true", "yes") else 0
            conn = connect()
            conn.execute(f"UPDATE computers SET {field} = ? WHERE id = ?", (flag, comp_id))
            conn.commit()
            conn.close()
            return jsonify({"ok": True, "data": {"id": comp_id, field: bool(flag)},
                            "error": None})

    new_name = (payload.get("name") or "").strip()
    if not new_name:
        return jsonify({"ok": False, "data": None, "error": "name is required"}), 400

    conn = connect()
    clash = conn.execute("SELECT 1 FROM computers WHERE name = ? AND id != ?", (new_name, comp_id)).fetchone()
    if clash:
        conn.close()
        return jsonify({"ok": False, "data": None, "error": f"'{new_name}' already exists"}), 409
    # Only the display name changes — the slug stays, so containers and any
    # in-flight task keep pointing at the same machine.
    conn.execute("UPDATE computers SET name = ? WHERE id = ?", (new_name, comp_id))
    conn.execute("UPDATE tasks SET desktop = ? WHERE desktop = ?", (new_name, comp["name"]))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "data": {"id": comp_id, "name": new_name}, "error": None})


@bp.route("/api/v1/computers/<int:comp_id>/restart", methods=["POST"])
@require_token
def api_computer_restart(comp_id: int):
    """Recreate a machine's containers in place.

    A machine can end up with its containers gone or wedged — the host
    rebooted, someone ran `docker rm`, the bridge died. Before this the only
    cure was delete-and-recreate, which lost the machine's name and port.
    """
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    try:
        # keep_home: a restart is meant to fix the machine, not wipe your work.
        fleet.destroy_computer(comp["slug"], keep_home=True)
        fleet.create_computer(comp["slug"], comp["novnc_port"],
                              comp["vnc_password"], image=comp["image"])
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None,
                        "error": f"failed to restart: {exc}"}), 500
    return jsonify({"ok": True, "data": {"id": comp_id, "restarted": True}, "error": None})


@bp.route("/api/v1/computers/<int:comp_id>/sleep", methods=["POST"])
@require_token
def api_computer_sleep(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    conn = connect()
    busy = conn.execute(
        "SELECT COUNT(*) AS n FROM tasks WHERE desktop = ? AND status IN ('PENDING','RUNNING')",
        (comp["name"],),
    ).fetchone()["n"]
    conn.close()
    if busy:
        return jsonify({"ok": False, "data": None,
                        "error": f"{comp['name']} has {busy} task(s) still running"}), 409
    try:
        fleet.suspend_computer(comp["slug"])
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": f"failed to sleep: {exc}"}), 500
    return jsonify({"ok": True, "data": {"id": comp_id, "sleeping": True}, "error": None})


@bp.route("/api/v1/computers/<int:comp_id>/wake", methods=["POST"])
@require_token
def api_computer_wake(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    try:
        result = wake_and_wait(comp)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": f"failed to wake: {exc}"}), 500
    # Started but not yet answering is not an error — the screen will come up
    # a moment later — so this reports readiness rather than failing.
    return jsonify({"ok": True, "data": {"id": comp_id, "sleeping": False, **result},
                    "error": None})


@bp.route("/api/v1/computers/<int:comp_id>/clipboard", methods=["GET"])
def api_clipboard_get(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    try:
        text = fleet.get_clipboard(comp["slug"])
    except fleet.ClipboardUnavailable as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 503
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 500
    return jsonify({"ok": True, "data": {"text": text}, "error": None})


@bp.route("/api/v1/computers/<int:comp_id>/clipboard", methods=["POST"])
@require_token
def api_clipboard_set(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    payload = request.get_json(silent=True) or {}
    text = payload.get("text")
    if text is None:
        return jsonify({"ok": False, "data": None, "error": "text is required"}), 400
    text = str(text)
    if len(text.encode("utf-8")) > MAX_CLIPBOARD_KB * 1024:
        return jsonify({"ok": False, "data": None,
                        "error": f"clipboard text over {MAX_CLIPBOARD_KB} KB"}), 413
    # "paste" also presses Ctrl+V, which is what makes Arabic typing work at
    # all — see fleet.paste_text.
    press = str(payload.get("paste", "")).lower() in ("1", "true", "yes")
    # Size and intent, not the text — an audit trail that archives everything
    # anyone pasted is its own kind of problem.
    g.audit_detail = f"{len(text.encode('utf-8'))} bytes, paste={press}"
    try:
        (fleet.paste_text if press else fleet.set_clipboard)(comp["slug"], text)
    except fleet.ClipboardUnavailable as exc:
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 503
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 500
    touch_active(comp_id)
    return jsonify({"ok": True, "data": {"id": comp_id, "bytes": len(text.encode("utf-8")),
                                         "pasted": press}, "error": None})


@bp.route("/api/v1/computers/<int:comp_id>", methods=["DELETE"])
@require_token
def api_computers_delete(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    try:
        fleet.destroy_computer(comp["slug"])
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": f"failed to remove containers: {exc}"}), 500
    conn = connect()
    conn.execute("DELETE FROM computers WHERE id = ?", (comp_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "data": {"id": comp_id, "removed": True}, "error": None})


@bp.route("/api/v1/computers/<int:comp_id>/inventory", methods=["GET"])
def api_computers_inventory(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    try:
        data = fleet.get_inventory(comp["slug"])
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 500
    return jsonify({"ok": True, "data": data, "error": None})


@bp.route("/partials/computers/<int:comp_id>/inventory")
def partial_inventory(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return "<div class='text-red-400 text-xs'>computer not found</div>", 404
    try:
        inv = fleet.get_inventory(comp["slug"])
    except Exception as exc:  # noqa: BLE001
        inv = {"error": str(exc)}
    return render_template("_inventory.html", comp=comp, inv=inv,
                           vnc_password=comp["vnc_password"])


@bp.route("/api/v1/computers/<int:comp_id>/exec", methods=["POST"])
@require_token
def api_computers_exec(comp_id: int):
    comp = get_computer(comp_id)
    if not comp:
        return jsonify({"ok": False, "data": None, "error": "not found"}), 404
    payload = request.get_json(silent=True) or {}
    command = (payload.get("command") or "").strip()
    if not command:
        return jsonify({"ok": False, "data": None, "error": "command is required"}), 400
    g.audit_detail = command[:500]
    try:
        result = fleet.exec_in_desktop(comp["slug"], command)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "data": None, "error": str(exc)}), 500
    return jsonify({"ok": True, "data": result, "error": None})


@bp.route("/api/v1/fleet")
def api_fleet():
    return jsonify({"ok": True, "data": computer_views(list_computers()), "error": None})
