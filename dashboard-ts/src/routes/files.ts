/** Getting files onto a machine, and off it. */

import { Hono, type Context } from "hono";
import { basename, dirname } from "node:path";
import * as fleet from "./../fleet";
import { getComputer, type Computer } from "./../machines";
import { render } from "./../templates";
import { requireToken } from "./../security";
import { MAX_UPLOAD_MB } from "./../settings";
import { fail, intParam, notFound, ok, type Env } from "./../http";

export const files = new Hono<Env>();

function loadComputer(c: Context<Env>): Computer | null {
  const id = intParam(c, "id");
  if (id === null) return null;
  const comp = getComputer(id);
  if (comp) c.set("auditTarget", comp.name);
  return comp;
}

files.get("/api/v1/computers/:id/files", async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  const rel = c.req.query("path") ?? "";
  try {
    return ok(c, { path: rel, entries: await fleet.listHome(comp.slug, rel) });
  } catch (err: any) {
    if (err instanceof fleet.PathOutsideHome) return fail(c, String(err.message));
    if (err instanceof fleet.HomePathMissing) {
      return fail(c, `no such folder: ${rel}`, 404);
    }
    return fail(c, String(err?.message ?? err), 500);
  }
});

files.post("/api/v1/computers/:id/files", requireToken, async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);

  const form = await c.req.formData().catch(() => null);
  const uploaded = form?.get("file");
  if (!(uploaded instanceof File) || !uploaded.name) {
    return fail(c, "no file supplied");
  }

  const data = new Uint8Array(await uploaded.arrayBuffer());
  if (data.length > MAX_UPLOAD_MB * 1024 * 1024) {
    return fail(c, `file is larger than ${MAX_UPLOAD_MB} MB`, 413);
  }

  // Land on the Desktop by default: the point is that you can see it.
  const relDir = String(form?.get("path") || "") || "Desktop";
  try {
    const path = await fleet.uploadToHome(comp.slug, relDir, basename(uploaded.name), data);
    return ok(c, { path, bytes: data.length }, 201);
  } catch (err: any) {
    if (err instanceof fleet.PathOutsideHome) return fail(c, String(err.message));
    return fail(c, String(err?.message ?? err), 500);
  }
});

files.get("/api/v1/computers/:id/files/download", async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  const rel = c.req.query("path") ?? "";
  if (!rel) return fail(c, "path is required");
  try {
    const [blob, name] = await fleet.downloadFromHome(comp.slug, rel);
    return c.body(blob as any, 200, {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${name}"`,
    });
  } catch (err: any) {
    if (err instanceof fleet.PathOutsideHome) return fail(c, String(err.message));
    return fail(c, String(err?.message ?? err), 404);
  }
});

files.get("/partials/computers/:id/files", async (c) => {
  const comp = loadComputer(c);
  if (!comp) return c.html("<div class='text-red-400 text-sm'>not found</div>", 404);
  const rel = c.req.query("path") ?? "";
  let entries: unknown[] = [];
  let error: string | null = null;
  try {
    entries = await fleet.listHome(comp.slug, rel);
  } catch (err: any) {
    error = String(err?.message ?? err);
  }
  const parent = rel ? dirname(rel.replace(/\/+$/, "")) : null;
  return c.html(
    render("_files.html", {
      comp,
      entries,
      path: rel,
      parent: parent === "." ? "" : parent,
      error,
      max_mb: MAX_UPLOAD_MB,
    }),
  );
});
