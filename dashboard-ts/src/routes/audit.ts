/** Reading the trail back. */

import { Hono } from "hono";
import * as audit from "./../audit";
import { all } from "./../db";
import { listComputers } from "./../machines";
import { render } from "./../templates";
import { PAGE_SIZE } from "./../settings";
import { ok, type Env } from "./../http";

export const auditRoutes = new Hono<Env>();

const pageOf = (raw: string | undefined) => {
  const n = parseInt(raw ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

auditRoutes.get("/api/v1/audit", (c) => {
  const { rows, pages } = audit.recent(
    PAGE_SIZE,
    pageOf(c.req.query("page")),
    c.req.query("target") || null,
    c.req.query("actor") || null,
  );
  return ok(c, rows, 200, { pages });
});

auditRoutes.get("/api/v1/audit/export.csv", (c) => {
  const rows = all<audit.AuditRow>("SELECT * FROM audit ORDER BY id DESC");
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    ["id", "at", "actor", "source_ip", "action", "target", "detail", "status", "ok"]
      .join(","),
  ];
  for (const r of rows) {
    lines.push(
      [r.id, r.at, r.actor, r.source_ip, r.action, r.target, r.detail, r.status, r.ok]
        .map(cell)
        .join(","),
    );
  }
  return c.body(lines.join("\r\n") + "\r\n", 200, {
    "content-type": "text/csv",
    "content-disposition": "attachment; filename=audit.csv",
  });
});

auditRoutes.get("/partials/audit", (c) => {
  const page = pageOf(c.req.query("page"));
  const { rows, pages } = audit.recent(
    PAGE_SIZE,
    page,
    c.req.query("target") || null,
  );
  return c.html(
    render("_audit.html", {
      rows,
      pages,
      page,
      target: c.req.query("target") ?? "",
      names: listComputers().map((x) => x.name),
    }),
  );
});
