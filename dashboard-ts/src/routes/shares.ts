/** Links that reach one machine, and the guest page behind them. */

import { Hono, type Context } from "hono";
import * as audit from "./../audit";
import * as fleet from "./../fleet";
import * as sharesLib from "./../shares";
import { one, run } from "./../db";
import {
  computerView,
  getComputer,
  listComputers,
  type Computer,
} from "./../machines";
import { bridgeScreenshot } from "./../screens";
import { render } from "./../templates";
import { requireToken } from "./../security";
import { SHOT_TTL } from "./../settings";
import {
  browserHost,
  fail,
  intParam,
  jsonBody,
  notFound,
  ok,
  sourceIp,
  type Env,
} from "./../http";

export const shares = new Hono<Env>();

function loadComputer(c: Context<Env>): Computer | null {
  const id = intParam(c, "id");
  if (id === null) return null;
  const comp = getComputer(id);
  if (comp) c.set("auditTarget", comp.name);
  return comp;
}

function shareBaseUrl(c: Context<Env>): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${c.req.header("host") ?? url.host}`;
}

function shareView(c: Context<Env>, row: sharesLib.ShareRow, compName?: string | null) {
  const { token_hash, ...rest } = row;
  return {
    ...rest,
    status: sharesLib.status(row),
    url: `${shareBaseUrl(c)}/s/${row.token}`,
    ...(compName ? { computer: compName } : {}),
  };
}

shares.get("/api/v1/shares", (c) => {
  const names = new Map(listComputers().map((x) => [x.id, x.name]));
  return ok(
    c,
    sharesLib.listing().map((r) => shareView(c, r, names.get(r.computer_id))),
  );
});

shares.post("/api/v1/computers/:id/shares", requireToken, async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  const payload = await jsonBody(c);
  let row: sharesLib.ShareRow;
  try {
    row = sharesLib.create(
      comp.id,
      String(payload.label ?? ""),
      String(payload.mode || "watch").trim(),
      payload.hours,
    );
  } catch (err: any) {
    if (err instanceof sharesLib.ValidationError) return fail(c, String(err.message));
    throw err;
  }
  c.set("auditDetail", `${row.mode} share '${row.label}' until ${row.expires_at}`);
  return ok(c, shareView(c, row, comp.name), 201);
});

shares.delete("/api/v1/shares/:id", requireToken, (c) => {
  const id = intParam(c, "id");
  const row = id === null ? null : one<sharesLib.ShareRow>(
    "SELECT * FROM shares WHERE id = ?",
    id,
  );
  if (!row) return notFound(c);
  const revoked = sharesLib.revoke(row.id);
  c.set("auditDetail", `share '${row.label}' (${row.mode})`);
  return ok(c, {
    id: row.id,
    revoked,
    // Being straight about what revoking a control share does and doesn't do
    // matters more than sounding reassuring.
    note:
      row.mode === "control"
        ? "the guest's browser already holds this machine's screen " +
          "password — rotate it to retract access completely"
        : null,
  });
});

/**
 * Give the machine a new screen password and restart it.
 *
 * This is the hard revoke behind a control share: anyone holding the old noVNC
 * URL is out, including a guest who saved it.
 */
shares.post("/api/v1/computers/:id/rotate-password", requireToken, async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  const password = fleet.randomVncPassword();
  try {
    await fleet.destroyComputer(comp.slug, true);
    await fleet.createComputer(comp.slug, comp.novnc_port, password, comp.image);
  } catch (err: any) {
    return fail(c, `failed to rotate: ${err?.message ?? err}`, 500);
  }
  run("UPDATE computers SET vnc_password = ? WHERE id = ?", password, comp.id);
  run(
    "UPDATE shares SET revoked = 1 WHERE computer_id = ? AND mode = 'control'",
    comp.id,
  );
  return ok(c, { id: comp.id, rotated: true });
});

/** The live share behind this request, or null. */
function currentShare(c: Context<Env>): sharesLib.ShareRow | null {
  const row = sharesLib.resolve(c.req.param("token") ?? "");
  if (row) {
    sharesLib.noteUse(row.id, sourceIp(c) || null);
    c.set("actor", `share:${row.label}`);
  }
  return row;
}

/** The page a guest sees. One machine, nothing else, no dashboard. */
shares.get("/s/:token", async (c) => {
  const row = currentShare(c);
  if (!row) return c.html(render("share_gone.html"), 404);
  const comp = getComputer(row.computer_id);
  if (!comp) return c.html(render("share_gone.html"), 404);
  const view = await computerView(comp, { host: browserHost(c) });
  audit.record(`GET /s/<token> (${row.mode})`, {
    actor: `share:${row.label}`,
    source_ip: sourceIp(c),
    target: comp.name,
    detail: "opened the share page",
    status: 200,
  });
  return c.html(
    render("share.html", { comp, view, share: row, token: c.req.param("token") }),
  );
});

/** The screen, served through the share rather than the machine's port —
 *  which is what makes a `watch` share fully revocable. */
shares.get("/s/:token/screen.png", async (c) => {
  const row = currentShare(c);
  if (!row) return c.text("not found", 404);
  const comp = getComputer(row.computer_id);
  if (!comp) return c.text("not found", 404);
  if (!(await fleet.isRunning(comp.slug))) return c.text("unavailable", 503);
  const png = await bridgeScreenshot(await computerView(comp, { withState: false }));
  if (png === null) return c.text("unavailable", 503);
  return c.body(png as any, 200, {
    "content-type": "image/png",
    "cache-control": `max-age=${Math.trunc(SHOT_TTL)}`,
  });
});
