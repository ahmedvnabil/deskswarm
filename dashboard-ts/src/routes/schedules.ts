/** Repeating a task on a timer. */

import { Hono } from "hono";
import { all, one, run } from "./../db";
import { getComputerByName } from "./../machines";
import { computeNextRun } from "./../scheduler";
import { render } from "./../templates";
import { requireToken } from "./../security";
import { nowIso } from "./../settings";
import { fail, intParam, jsonBody, notFound, ok, type Env } from "./../http";

export const schedules = new Hono<Env>();

const listRows = () => all("SELECT * FROM schedules ORDER BY id DESC");

schedules.get("/partials/schedules", (c) =>
  c.html(render("_schedules.html", { schedules: listRows() })),
);

schedules.get("/api/v1/schedules", (c) => ok(c, listRows()));

schedules.post("/api/v1/schedules", requireToken, async (c) => {
  const payload = await jsonBody(c);
  const description = String(payload.description ?? "").trim();
  const desktop = String(payload.desktop || "all").trim();
  const kind = String(payload.kind || "interval").trim();

  if (!description) return fail(c, "description is required");
  if (!["interval", "daily"].includes(kind)) {
    return fail(c, "kind must be 'interval' or 'daily'");
  }

  let everyMinutes: number | null = null;
  let atTime: string | null = null;
  if (kind === "interval") {
    const raw = payload.every_minutes ?? 60;
    everyMinutes = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    if (!Number.isFinite(everyMinutes)) {
      return fail(c, "every_minutes must be a number");
    }
    if (everyMinutes < 1) return fail(c, "every_minutes must be >= 1");
  } else {
    atTime = String(payload.at_time ?? "").trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(atTime)) {
      return fail(c, "at_time must be HH:MM (24h UTC)");
    }
  }

  if (desktop !== "all" && !getComputerByName(desktop)) {
    return fail(c, `unknown computer '${desktop}'`);
  }

  const { lastInsertRowid } = run(
    "INSERT INTO schedules (desktop, description, kind, every_minutes, at_time, " +
      "enabled, next_run_at, created_at) VALUES (?,?,?,?,?,1,?,?)",
    desktop,
    description,
    kind,
    everyMinutes,
    atTime,
    computeNextRun(kind, everyMinutes, atTime),
    nowIso(),
  );
  return ok(c, one("SELECT * FROM schedules WHERE id = ?", lastInsertRowid), 201);
});

schedules.patch("/api/v1/schedules/:id", requireToken, async (c) => {
  const id = intParam(c, "id");
  const row = id === null ? null : one<{
    id: number;
    kind: string;
    every_minutes: number | null;
    at_time: string | null;
    next_run_at: string;
  }>("SELECT * FROM schedules WHERE id = ?", id);
  if (!row) return notFound(c);

  const payload = await jsonBody(c);
  const enabled = ["1", "true", "yes"].includes(
    String(payload.enabled ?? "1").toLowerCase(),
  )
    ? 1
    : 0;
  const next = enabled
    ? computeNextRun(row.kind, row.every_minutes, row.at_time)
    : row.next_run_at;
  run(
    "UPDATE schedules SET enabled = ?, next_run_at = ? WHERE id = ?",
    enabled,
    next,
    row.id,
  );
  return ok(c, { id: row.id, enabled: !!enabled });
});

schedules.delete("/api/v1/schedules/:id", requireToken, (c) => {
  const id = intParam(c, "id");
  if (id === null || !one("SELECT 1 AS x FROM schedules WHERE id = ?", id)) {
    return notFound(c);
  }
  run("DELETE FROM schedules WHERE id = ?", id);
  return ok(c, { id, removed: true });
});
