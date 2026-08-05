/** Archiving a machine's home directory, and putting it back. */

import { Hono, type Context } from "hono";
import { createReadStream, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import * as backups from "./../backups";
import * as guards from "./../guards";
import { getComputer, type Computer } from "./../machines";
import { render } from "./../templates";
import { requireToken } from "./../security";
import { fail, intParam, jsonBody, notFound, ok, type Env } from "./../http";

export const backupRoutes = new Hono<Env>();

function loadComputer(c: Context<Env>): Computer | null {
  const id = intParam(c, "id");
  if (id === null) return null;
  const comp = getComputer(id);
  if (comp) c.set("auditTarget", comp.name);
  return comp;
}

backupRoutes.get("/api/v1/computers/:id/backups", (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  return ok(c, backups.listing(comp.slug));
});

backupRoutes.post("/api/v1/computers/:id/backups", requireToken, async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  const [diskOk, diskMsg] = guards.checkDisk();
  if (!diskOk) return fail(c, diskMsg, 507);
  try {
    const meta = await backups.create(comp.slug);
    c.set("auditDetail", `${meta.name} (${meta.bytes} bytes)`);
    return ok(c, meta, 201);
  } catch (err: any) {
    return fail(c, `backup failed: ${err?.message ?? err}`, 500);
  }
});

backupRoutes.get("/api/v1/computers/:id/backups/:name", (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  let path: string;
  try {
    path = backups.backupPath(comp.slug, c.req.param("name"));
  } catch (err: any) {
    return fail(c, String(err.message));
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    return fail(c, "no such backup", 404);
  }
  // Streamed, not read: a home directory runs to hundreds of megabytes and
  // buffering one to answer a download would undo the point of streaming it in.
  const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
  return c.body(stream, 200, {
    "content-type": "application/gzip",
    "content-disposition": `attachment; filename="${comp.slug}-${c.req.param("name")}"`,
    "content-length": String(statSync(path).size),
  });
});

backupRoutes.delete("/api/v1/computers/:id/backups/:name", requireToken, (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  const name = c.req.param("name");
  let removed: boolean;
  try {
    removed = backups.remove(comp.slug, name);
  } catch (err: any) {
    return fail(c, String(err.message));
  }
  if (!removed) return fail(c, "no such backup", 404);
  c.set("auditDetail", name);
  return ok(c, { removed: name });
});

/** Put a backup back. The machine is stopped for the duration and restarted
 *  afterwards if it was running. */
backupRoutes.post("/api/v1/computers/:id/restore", requireToken, async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  const payload = await jsonBody(c);
  const name = String(payload.backup ?? "").trim();
  const sourceSlug = String(payload.from || comp.slug).trim();
  if (!name) return fail(c, "backup is required");

  let path: string;
  try {
    path = backups.backupPath(sourceSlug, name);
  } catch (err: any) {
    return fail(c, String(err.message));
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    return fail(c, "no such backup", 404);
  }

  c.set("auditDetail", `from ${sourceSlug}/${name}`);
  try {
    return ok(c, await backups.restore(comp.slug, path));
  } catch (err: any) {
    return fail(c, `restore failed: ${err?.message ?? err}`, 500);
  }
});

/**
 * Restore from a file the user hands us, rather than one we made.
 *
 * This is how a machine is rebuilt on a different host — and why
 * `backups.sanitise` refuses members that climb out of the home directory:
 * from here the archive is entirely untrusted input.
 */
backupRoutes.post("/api/v1/computers/:id/restore/upload", requireToken, async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  const form = await c.req.formData().catch(() => null);
  const upload = form?.get("file");
  if (!(upload instanceof File) || !upload.name) return fail(c, "file is required");

  const tmp = join(tmpdir(), `deskswarm-restore-${comp.slug}-${process.pid}.tar.gz`);
  c.set("auditDetail", `uploaded ${upload.name}`);
  try {
    await Bun.write(tmp, upload);
    return ok(c, await backups.restore(comp.slug, tmp));
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    // gunzip rejects anything that isn't one, which is the common case here:
    // someone picked the wrong file.
    if (/incorrect header check|unexpected end of file|invalid|gzip/i.test(msg)) {
      return fail(c, "that file is not a readable .tar.gz backup");
    }
    return fail(c, `restore failed: ${msg}`, 500);
  } finally {
    rmSync(tmp, { force: true });
  }
});

backupRoutes.get("/partials/computers/:id/backups", (c) => {
  const comp = loadComputer(c);
  if (!comp) return c.html("<div class='text-red-400 text-sm'>not found</div>", 404);
  return c.html(
    render("_backups.html", {
      comp,
      rows: backups.listing(comp.slug),
      keep: backups.keepPerMachine(),
      daily_at: backups.DAILY_AT,
    }),
  );
});
