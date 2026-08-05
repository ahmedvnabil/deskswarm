/** Dispatching work to machines, and reading back what happened. */

import { Hono } from "hono";
import * as fleet from "./../fleet";
import { all, one } from "./../db";
import { getComputerByName, listComputers } from "./../machines";
import {
  buildAnalytics,
  computeDurationSeconds,
  createTaskRow,
  dispatchTask,
  getTaskRow,
  runTaskWorker,
  updateTaskRow,
  ValidationError,
  type TaskRow,
} from "./../tasks";
import { render } from "./../templates";
import { requireToken } from "./../security";
import { PAGE_SIZE } from "./../settings";
import { fail, intParam, jsonBody, notFound, ok, type Env } from "./../http";

export const tasks = new Hono<Env>();

/** The filter the tasks table and its partial share. */
function queryTasks(desktop: string, status: string, page: number) {
  const where: string[] = [];
  const params: any[] = [];
  if (desktop) {
    where.push("desktop = ?");
    params.push(desktop);
  }
  if (status === "ACTIVE") {
    where.push("status IN ('PENDING', 'RUNNING')");
  } else if (["COMPLETED", "FAILED", "CANCELLED"].includes(status)) {
    where.push("status = ?");
    params.push(status);
  }
  const clause = where.length ? " WHERE " + where.join(" AND ") : "";

  const total =
    one<{ c: number }>(`SELECT COUNT(*) c FROM tasks${clause}`, ...params)?.c ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const wanted = Math.min(page, pages);
  const rows = all<TaskRow>(
    `SELECT * FROM tasks${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...params,
    PAGE_SIZE,
    (wanted - 1) * PAGE_SIZE,
  );
  for (const r of rows) r.duration_seconds = computeDurationSeconds(r);
  return { rows, pages, page: wanted, total };
}

tasks.get("/partials/tasks", (c) => {
  const desktop = (c.req.query("desktop") ?? "").trim();
  const status = (c.req.query("status") ?? "").trim().toUpperCase();
  const asked = parseInt(c.req.query("page") ?? "1", 10);
  const { rows, pages, page, total } = queryTasks(
    desktop,
    status,
    Number.isFinite(asked) ? Math.max(1, asked) : 1,
  );
  return c.html(
    render("_tasks.html", {
      tasks: rows,
      names: listComputers().map((x) => x.name),
      sel_desktop: desktop,
      sel_status: status,
      page,
      pages,
      total,
    }),
  );
});

tasks.get("/partials/analytics", (c) =>
  c.html(render("_analytics.html", { analytics: buildAnalytics() })),
);

tasks.get("/api/v1/analytics", (c) => ok(c, buildAnalytics()));

tasks.get("/api/v1/tasks", (c) => {
  const rows = all<TaskRow>("SELECT * FROM tasks ORDER BY id DESC LIMIT 100");
  for (const r of rows) r.duration_seconds = computeDurationSeconds(r);
  return ok(c, rows);
});

tasks.get("/api/v1/tasks/export.csv", (c) => {
  const rows = all<TaskRow>("SELECT * FROM tasks ORDER BY id DESC");
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    ["id", "desktop", "description", "status", "result_text", "cost_usd",
     "duration_seconds", "error", "created_at", "updated_at"].join(","),
  ];
  for (const d of rows) {
    lines.push(
      [
        d.id, d.desktop, d.description, d.status, d.result_text ?? "",
        d.cost_usd ?? "", computeDurationSeconds(d) ?? "", d.error ?? "",
        d.created_at, d.updated_at,
      ].map(cell).join(","),
    );
  }
  return c.body(lines.join("\r\n") + "\r\n", 200, {
    "content-type": "text/csv",
    "content-disposition": "attachment; filename=deskswarm-tasks.csv",
  });
});

tasks.get("/api/v1/tasks/:id", (c) => {
  const id = intParam(c, "id");
  const row = id === null ? null : getTaskRow(id);
  if (!row) return notFound(c);
  row.duration_seconds = computeDurationSeconds(row);
  return ok(c, row);
});

tasks.post("/api/v1/tasks", requireToken, async (c) => {
  const payload = await jsonBody(c);
  const description = String(payload.description ?? "").trim();
  const target = String(payload.desktop || "all");
  if (!description) return fail(c, "description is required");
  try {
    return ok(c, { task_ids: dispatchTask(target, description) }, 201);
  } catch (err: any) {
    if (err instanceof ValidationError) return fail(c, String(err.message));
    throw err;
  }
});

tasks.post("/api/v1/tasks/:id/cancel", requireToken, (c) => {
  const id = intParam(c, "id");
  const row = id === null ? null : getTaskRow(id);
  if (!row) return notFound(c);
  if (!["PENDING", "RUNNING"].includes(row.status)) {
    return fail(c, `task is ${row.status}, cannot cancel`);
  }
  updateTaskRow(row.id, {
    status: "CANCELLED",
    current_action: null,
    error: "cancelled by user",
  });
  if (row.pid) {
    try {
      process.kill(row.pid, "SIGTERM");
    } catch {
      /* already gone — the row is what mattered */
    }
  }
  return ok(c, { id: row.id, status: "CANCELLED" });
});

tasks.post("/api/v1/tasks/:id/retry", requireToken, (c) => {
  const id = intParam(c, "id");
  const row = id === null ? null : getTaskRow(id);
  if (!row) return notFound(c);
  const comp = getComputerByName(row.desktop);
  if (!comp) return fail(c, `computer '${row.desktop}' no longer exists`);

  const newId = createTaskRow(comp.name, row.description);
  void runTaskWorker(newId, fleet.bridgeContainerName(comp.slug), 8000, row.description);
  return ok(c, { task_id: newId }, 201);
});
