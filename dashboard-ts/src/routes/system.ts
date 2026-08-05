/** Health, the page itself, the guards panel and space reclaim. */

import { Hono } from "hono";
import * as guards from "./../guards";
import { docker } from "./../docker";
import { budgetedMachineCount, listComputers } from "./../machines";
import { render } from "./../templates";
import { requireToken } from "./../security";
import { fail, ok, type Env } from "./../http";

export const system = new Hono<Env>();

system.get("/health", (c) => c.json({ status: "ok" }));

system.get("/", (c) =>
  c.html(render("index.html", { computers: listComputers() })),
);

system.get("/api/v1/guards", async (c) =>
  ok(c, guards.status(await budgetedMachineCount())),
);

system.get("/partials/guards", async (c) =>
  c.html(render("_guards.html", { g: guards.status(await budgetedMachineCount()) })),
);

/**
 * Reclaim the space Docker holds but no longer needs.
 *
 * Only build cache and dangling layers — never a tagged image, so a snapshot
 * someone is relying on can't vanish because the disk got tight.
 */
system.post("/api/v1/maintenance/prune", requireToken, async (c) => {
  const before = guards.diskFreeGb();
  let reclaimed = 0;
  try {
    const builder = await (docker() as any).pruneBuilder?.().catch(() => null);
    reclaimed += builder?.SpaceReclaimed ?? 0;
    const images = await docker().pruneImages({ filters: { dangling: { true: true } } });
    reclaimed += (images as any)?.SpaceReclaimed ?? 0;
  } catch (err: any) {
    return fail(c, `prune failed: ${err?.message ?? err}`, 500);
  }
  return ok(c, {
    reclaimed_gb: Math.round((reclaimed / 1e9) * 100) / 100,
    disk_free_gb_before: before,
    disk_free_gb_after: guards.diskFreeGb(),
  });
});
