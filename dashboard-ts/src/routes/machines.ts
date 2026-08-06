/** Adding, inspecting, driving and removing machines. */

import { Hono, type Context } from "hono";
import { providerFor, ClipboardUnavailable } from "./../providers";
import * as guards from "./../guards";
import { one, run } from "./../db";
import {
  budgetedMachineCount,
  computerViews,
  createOneComputer,
  expandNames,
  getComputer,
  listComputers,
  touchActive,
  wakeAndWait,
  ValidationError,
  type Computer,
} from "./../machines";
import { activeTaskByComputer } from "./../tasks";
import { render } from "./../templates";
import { requireToken } from "./../security";
import { MAX_CLIPBOARD_KB, SHOT_TTL } from "./../settings";
import {
  browserHost,
  fail,
  intParam,
  jsonBody,
  notFound,
  ok,
  type Env,
} from "./../http";

export const machines = new Hono<Env>();

/**
 * Nearly every per-machine handler starts here, so naming the machine for the
 * audit log once means no handler has to remember to do it.
 */
function loadComputer(c: Context<Env>): Computer | null {
  const id = intParam(c, "id");
  if (id === null) return null;
  const comp = getComputer(id);
  if (comp) c.set("auditTarget", comp.name);
  return comp;
}

const truthy = (v: unknown) => ["1", "true", "yes"].includes(String(v).toLowerCase());

machines.get("/partials/fleet", async (c) => {
  const busy = activeTaskByComputer();
  const computers = await computerViews(listComputers(), browserHost(c));
  for (const view of computers) view.active_task = busy[view.name];
  return c.html(
    render("_fleet.html", {
      computers,
      shot_token: Math.floor(Date.now() / 1000 / SHOT_TTL),
    }),
  );
});

machines.get("/api/v1/computers", async (c) =>
  ok(c, await computerViews(listComputers(), browserHost(c))),
);

machines.get("/api/v1/fleet", async (c) =>
  ok(c, await computerViews(listComputers(), browserHost(c))),
);

machines.post("/api/v1/computers", requireToken, async (c) => {
  const payload = await jsonBody(c);
  const name = String(payload.name ?? "").trim();
  const snapshotName = String(payload.snapshot ?? "").trim();
  if (!name) return fail(c, "name is required");

  let image: string | null = null;
  if (snapshotName) {
    const snap = one<{ image: string }>(
      "SELECT * FROM snapshots WHERE name = ?",
      snapshotName,
    );
    if (!snap) return fail(c, `unknown snapshot '${snapshotName}'`);
    image = snap.image;
  }

  let names: string[];
  try {
    names = expandNames(name);
  } catch (err: any) {
    return fail(c, String(err.message));
  }

  const fleetSize = await budgetedMachineCount();
  for (const [passed, msg] of [
    guards.checkMemory(names.length, fleetSize),
    guards.checkDisk(),
  ]) {
    if (!passed) return fail(c, msg, 507);
  }

  const created: unknown[] = [];
  const errors: { name: string; error: string }[] = [];
  for (const n of names) {
    try {
      created.push(await createOneComputer(n, image));
    } catch (err: any) {
      errors.push({
        name: n,
        error:
          err instanceof ValidationError
            ? String(err.message)
            : `failed to start containers: ${err?.message ?? err}`,
      });
    }
  }

  if (!created.length) {
    const msg = errors[0]?.error ?? "nothing created";
    const code = msg.includes("already exists") ? 409 : 500;
    return fail(c, msg, code, { errors });
  }

  // Creation is the one mutation with no machine to look up beforehand, so the
  // audit target has to be named here rather than by loadComputer.
  c.set("auditTarget", names.length === 1 ? names[0] : null);
  c.set(
    "auditDetail",
    `created ${created.length}` +
      (errors.length ? `, ${errors.length} failed` : "") +
      (names.length > 1
        ? ` (${created.slice(0, 8).map((x: any) => x.name).join(", ")})`
        : ""),
  );

  // Single-name requests keep returning the bare object they always did.
  const data = names.length === 1 ? created[0] : { created, errors };
  return ok(c, data, 201);
});

machines.patch("/api/v1/computers/:id", requireToken, async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  const payload = await jsonBody(c);

  // Same endpoint also flips the boolean flags, which carry no name.
  for (const field of ["reserved", "no_suspend"] as const) {
    if (field in payload && !("name" in payload)) {
      const flag = truthy(payload[field]) ? 1 : 0;
      run(`UPDATE computers SET ${field} = ? WHERE id = ?`, flag, comp.id);
      return ok(c, { id: comp.id, [field]: !!flag });
    }
  }

  const newName = String(payload.name ?? "").trim();
  if (!newName) return fail(c, "name is required");
  const clash = one(
    "SELECT 1 AS x FROM computers WHERE name = ? AND id != ?",
    newName,
    comp.id,
  );
  if (clash) return fail(c, `'${newName}' already exists`, 409);

  // Only the display name changes — the slug stays, so containers and any
  // in-flight task keep pointing at the same machine.
  run("UPDATE computers SET name = ? WHERE id = ?", newName, comp.id);
  run("UPDATE tasks SET desktop = ? WHERE desktop = ?", newName, comp.name);
  return ok(c, { id: comp.id, name: newName });
});

/**
 * Recreate a machine's containers in place.
 *
 * A machine can end up with its containers gone or wedged — the host rebooted,
 * someone ran `docker rm`, the bridge died. Before this the only cure was
 * delete-and-recreate, which lost the machine's name and port.
 */
machines.post("/api/v1/computers/:id/restart", requireToken, async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  try {
    // keep_home: a restart is meant to fix the machine, not wipe your work.
    const backend = providerFor(comp);
    await backend.destroyComputer(comp.slug, true);
    await backend.createComputer(comp.slug, comp.novnc_port, comp.vnc_password, comp.image);
  } catch (err: any) {
    return fail(c, `failed to restart: ${err?.message ?? err}`, 500);
  }
  return ok(c, { id: comp.id, restarted: true });
});

machines.post("/api/v1/computers/:id/sleep", requireToken, async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  const busy =
    one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tasks WHERE desktop = ? AND status IN ('PENDING','RUNNING')",
      comp.name,
    )?.n ?? 0;
  if (busy) {
    return fail(c, `${comp.name} has ${busy} task(s) still running`, 409);
  }
  try {
    await providerFor(comp).suspendComputer(comp.slug);
  } catch (err: any) {
    return fail(c, `failed to sleep: ${err?.message ?? err}`, 500);
  }
  return ok(c, { id: comp.id, sleeping: true });
});

machines.post("/api/v1/computers/:id/wake", requireToken, async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  let result;
  try {
    result = await wakeAndWait(comp);
  } catch (err: any) {
    return fail(c, `failed to wake: ${err?.message ?? err}`, 500);
  }
  // Started but not yet answering is not an error — the screen will come up a
  // moment later — so this reports readiness rather than failing.
  return ok(c, { id: comp.id, sleeping: false, ...result });
});

machines.get("/api/v1/computers/:id/clipboard", async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  try {
    return ok(c, { text: await providerFor(comp).getClipboard(comp.slug) });
  } catch (err: any) {
    const code = err instanceof ClipboardUnavailable ? 503 : 500;
    return fail(c, String(err?.message ?? err), code);
  }
});

machines.post("/api/v1/computers/:id/clipboard", requireToken, async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  const payload = await jsonBody(c);
  if (payload.text === undefined || payload.text === null) {
    return fail(c, "text is required");
  }
  const text = String(payload.text);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_CLIPBOARD_KB * 1024) {
    return fail(c, `clipboard text over ${MAX_CLIPBOARD_KB} KB`, 413);
  }
  // "paste" also presses Ctrl+V, which is what makes Arabic typing work at
  // all — see the provider's pasteText.
  const press = truthy(payload.paste ?? "");
  // Size and intent, not the text — an audit trail that archives everything
  // anyone pasted is its own kind of problem.
  c.set("auditDetail", `${bytes} bytes, paste=${press}`);
  try {
    const backend = providerFor(comp);
    if (press) await backend.pasteText(comp.slug, text);
    else await backend.setClipboard(comp.slug, text);
  } catch (err: any) {
    const code = err instanceof ClipboardUnavailable ? 503 : 500;
    return fail(c, String(err?.message ?? err), code);
  }
  touchActive(comp.id);
  return ok(c, { id: comp.id, bytes, pasted: press });
});

machines.delete("/api/v1/computers/:id", requireToken, async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  try {
    await providerFor(comp).destroyComputer(comp.slug);
  } catch (err: any) {
    return fail(c, `failed to remove containers: ${err?.message ?? err}`, 500);
  }
  run("DELETE FROM computers WHERE id = ?", comp.id);
  return ok(c, { id: comp.id, removed: true });
});

machines.get("/api/v1/computers/:id/inventory", async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  try {
    return ok(c, await providerFor(comp).getInventory(comp.slug));
  } catch (err: any) {
    return fail(c, String(err?.message ?? err), 500);
  }
});

machines.get("/partials/computers/:id/inventory", async (c) => {
  const comp = loadComputer(c);
  if (!comp) {
    return c.html("<div class='text-red-400 text-xs'>computer not found</div>", 404);
  }
  let inv: unknown;
  try {
    inv = await providerFor(comp).getInventory(comp.slug);
  } catch (err: any) {
    inv = { error: String(err?.message ?? err) };
  }
  return c.html(
    render("_inventory.html", { comp, inv, vnc_password: comp.vnc_password }),
  );
});

machines.post("/api/v1/computers/:id/exec", requireToken, async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  const payload = await jsonBody(c);
  const command = String(payload.command ?? "").trim();
  if (!command) return fail(c, "command is required");
  c.set("auditDetail", command.slice(0, 500));
  try {
    return ok(c, await providerFor(comp).execInDesktopResult(comp.slug, command));
  } catch (err: any) {
    return fail(c, String(err?.message ?? err), 500);
  }
});
