"""Reading the trail back."""

import csv
import io
from flask import Blueprint, Response, jsonify, render_template, request

import audit
from db import connect
from machines import list_computers
from settings import PAGE_SIZE


bp = Blueprint("audit", __name__)


@bp.route("/api/v1/audit")
def api_audit():
    conn = connect()
    rows, pages = audit.recent(conn, limit=PAGE_SIZE,
                               page=int(request.args.get("page", 1) or 1),
                               target=request.args.get("target") or None,
                               actor=request.args.get("actor") or None)
    conn.close()
    return jsonify({"ok": True, "data": rows, "error": None, "meta": {"pages": pages}})


@bp.route("/api/v1/audit/export.csv")
def api_audit_export():
    conn = connect()
    rows = conn.execute("SELECT * FROM audit ORDER BY id DESC").fetchall()
    conn.close()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "at", "actor", "source_ip", "action", "target", "detail",
                "status", "ok"])
    for r in rows:
        w.writerow([r["id"], r["at"], r["actor"], r["source_ip"], r["action"],
                    r["target"], r["detail"], r["status"], r["ok"]])
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=audit.csv"})


@bp.route("/partials/audit")
def partial_audit():
    conn = connect()
    rows, pages = audit.recent(conn, limit=PAGE_SIZE,
                               page=int(request.args.get("page", 1) or 1),
                               target=request.args.get("target") or None)
    names = [c["name"] for c in list_computers()]
    conn.close()
    return render_template("_audit.html", rows=rows, pages=pages,
                           page=int(request.args.get("page", 1) or 1),
                           target=request.args.get("target", ""), names=names)
