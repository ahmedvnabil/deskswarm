/** Freezing a provisioned machine into an image, and the wall's stills. */

import { Hono, type Context } from "hono";
import { providerFor, providerByName, slugify } from "./../providers";
import * as guards from "./../guards";
import { all, one, run } from "./../db";
import { computerView, getComputer, type Computer } from "./../machines";
import { bridgeScreenshot } from "./../screens";
import { requireToken } from "./../security";
import { SHOT_TTL, nowIso } from "./../settings";
import { fail, intParam, notFound, ok, type Env } from "./../http";

export const snapshots = new Hono<Env>();

function loadComputer(c: Context<Env>): Computer | null {
  const id = intParam(c, "id");
  if (id === null) return null;
  const comp = getComputer(id);
  if (comp) c.set("auditTarget", comp.name);
  return comp;
}

snapshots.get("/api/v1/snapshots", (c) =>
  ok(c, all("SELECT * FROM snapshots ORDER BY id DESC")),
);

/** Freeze a provisioned machine into a reusable image. */
snapshots.post("/api/v1/computers/:id/snapshot", requireToken, async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);

  const payload = await c.req.json().catch(() => ({}) as any);
  const name = String(payload?.name ?? "").trim();
  if (!name) return fail(c, "name is required");

  const [diskOk, diskMsg] = guards.checkDisk();
  if (!diskOk) return fail(c, diskMsg, 507);

  if (one("SELECT 1 AS x FROM snapshots WHERE name = ?", name)) {
    return fail(c, `snapshot '${name}' already exists`, 409);
  }

  let image: string;
  try {
    image = await providerFor(comp).snapshotComputer(comp.slug, slugify(name));
  } catch (err: any) {
    return fail(c, `snapshot failed: ${err?.message ?? err}`, 500);
  }

  run(
    "INSERT INTO snapshots (name, image, source, provider, created_at) VALUES (?,?,?,?,?)",
    name,
    image,
    comp.name,
    providerFor(comp).name,
    nowIso(),
  );
  return ok(c, one("SELECT * FROM snapshots WHERE name = ?", name), 201);
});

snapshots.delete("/api/v1/snapshots/:id", requireToken, async (c) => {
  const id = intParam(c, "id");
  const row = id === null ? null : one<{ id: number; image: string; provider: string | null }>(
    "SELECT * FROM snapshots WHERE id = ?",
    id,
  );
  if (!row) return notFound(c);
  const inUse =
    one<{ c: number }>("SELECT COUNT(*) AS c FROM computers WHERE image = ?", row.image)
      ?.c ?? 0;
  run("DELETE FROM snapshots WHERE id = ?", row.id);
  // Only drop the image when nothing is running off it.
  if (!inUse) {
    try {
      await providerByName(row.provider).removeImage(row.image);
    } catch {
      /* the row is gone either way; a stuck image is not worth a 500 */
    }
  }
  return ok(c, { id: row.id, removed: true, image_kept: !!inUse });
});

snapshots.get("/api/v1/computers/:id/screenshot", async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  // A sleeping machine has no screen to capture. Saying so immediately beats
  // spending the bridge's full 12s timeout on every tile, every refresh.
  try {
    const state = await providerFor(comp).containerState(comp.slug);
    if (state.desktop_state === "exited") return fail(c, "sleeping", 503);
  } catch {
    /* if Docker can't say, try the bridge anyway */
  }
  const png = await bridgeScreenshot(await computerView(comp, { withState: false }));
  if (png === null) return fail(c, "screen unavailable", 503);
  return c.body(png as any, 200, {
    "content-type": "image/png",
    "cache-control": `max-age=${Math.trunc(SHOT_TTL)}`,
  });
});
