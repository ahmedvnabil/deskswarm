/** Issuing and revoking the keys that let an outside client drive a machine. */

import { Hono, type Context } from "hono";
import * as keysLib from "./../mcp/keys";
import { toolManifest } from "./../mcp/tools";
import { tail } from "./../mcp/activity";
import * as audit from "./../audit";
import { one } from "./../db";
import { getComputer, listComputers, type Computer } from "./../machines";
import { render } from "./../templates";
import { requireToken } from "./../security";
import { MCP_PUBLIC_ORIGIN, PAGE_SIZE } from "./../settings";
import { fail, intParam, jsonBody, notFound, ok, type Env } from "./../http";

export const keyRoutes = new Hono<Env>();

function loadComputer(c: Context<Env>): Computer | null {
  const id = intParam(c, "id");
  if (id === null) return null;
  const comp = getComputer(id);
  if (comp) c.set("auditTarget", comp.name);
  return comp;
}

/**
 * The origin an MCP client should be pointed at.
 *
 * Derived from the request by default, which is right whenever the browser and
 * the client reach this the same way. DESKSWARM_MCP_PUBLIC_ORIGIN overrides it
 * for the case that breaks: browsing over a LAN address while the client will
 * connect over the public name.
 */
function mcpOrigin(c: Context<Env>): string {
  if (MCP_PUBLIC_ORIGIN) return MCP_PUBLIC_ORIGIN;
  const url = new URL(c.req.url);
  // Behind a TLS-terminating proxy the request arrives as http; the URL a
  // client must use is the one the browser is on, not the one we received.
  const proto = c.req.header("x-forwarded-proto") || url.protocol.replace(":", "");
  return `${proto}://${c.req.header("host") ?? url.host}`;
}

export const mcpUrl = (c: Context<Env>, slug: string) =>
  `${mcpOrigin(c)}/mcp/${slug}`;

/**
 * The row as the UI and the API see it.
 *
 * The token is included, because a key you cannot read again is a key someone
 * stores somewhere worse — and it is already in the database in the clear. The
 * hash is not: it is an implementation detail and showing it invites someone
 * to treat it as the credential.
 */
function keyView(c: Context<Env>, row: keysLib.KeyRow, comp?: Computer | null) {
  const { token_hash, ...rest } = row;
  return {
    ...rest,
    status: keysLib.status(row),
    ...(comp
      ? {
          computer: comp.name,
          slug: comp.slug,
          url: mcpUrl(c, comp.slug),
          // Ready to paste. The one command that turns a key into a working
          // client is worth more here than a paragraph describing it.
          claude_code: `claude mcp add --transport http ${comp.slug} ${mcpUrl(
            c,
            comp.slug,
          )} --header "Authorization: Bearer ${row.token}"`,
        }
      : {}),
  };
}

keyRoutes.get("/api/v1/keys", (c) => {
  const comps = new Map(listComputers().map((x) => [x.id, x]));
  return ok(
    c,
    keysLib.listing().map((r) => keyView(c, r, comps.get(r.computer_id))),
  );
});

keyRoutes.get("/api/v1/computers/:id/keys", (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  return ok(
    c,
    keysLib.listing(comp.id).map((r) => keyView(c, r, comp)),
  );
});

keyRoutes.post("/api/v1/computers/:id/keys", requireToken, async (c) => {
  const comp = loadComputer(c);
  if (!comp) return notFound(c);
  // A reserved machine is one you have claimed for yourself; handing out a key
  // to it would let a client take the keyboard while you are using it. Un-mark
  // it first — that is a deliberate act rather than a surprise.
  if (comp.reserved) {
    return fail(
      c,
      `${comp.name} is reserved for you — unmark it before issuing a key`,
      409,
    );
  }
  const payload = await jsonBody(c);
  let row: keysLib.KeyRow;
  try {
    row = keysLib.create(comp.id, String(payload.label ?? ""), payload.days);
  } catch (err: any) {
    if (err instanceof keysLib.ValidationError) return fail(c, String(err.message));
    throw err;
  }
  c.set(
    "auditDetail",
    `key '${row.label}' ${row.expires_at ? `until ${row.expires_at}` : "with no expiry"}`,
  );
  return ok(c, keyView(c, row, comp), 201);
});

keyRoutes.delete("/api/v1/keys/:id", requireToken, (c) => {
  const id = intParam(c, "id");
  const row =
    id === null ? null : one<keysLib.KeyRow>("SELECT * FROM mcp_keys WHERE id = ?", id);
  if (!row) return notFound(c);
  const comp = getComputer(row.computer_id);
  if (comp) c.set("auditTarget", comp.name);
  const revoked = keysLib.revoke(row.id);
  c.set("auditDetail", `key '${row.label}'`);
  // Revoking is complete here, unlike a control share: the key is the only way
  // in over MCP, nothing was handed to a browser, and the next call fails.
  return ok(c, { id: row.id, revoked });
});

// ------------------------------------------------------------------ panels

/** The access panel for one machine: endpoint, keys, and what a client can do. */
keyRoutes.get("/partials/computers/:id/access", (c) => {
  const comp = loadComputer(c);
  if (!comp) {
    return c.html("<div class='text-red-400 text-xs'>computer not found</div>", 404);
  }
  return c.html(
    render("_access.html", {
      comp,
      url: mcpUrl(c, comp.slug),
      keys: keysLib.listing(comp.id).map((r) => keyView(c, r, comp)),
      tools: toolManifest(),
      recent: tail(comp.name, 12),
    }),
  );
});

/**
 * What outside clients have been doing, fleet-wide.
 *
 * Reads the audit table rather than the in-memory ring: this is the record,
 * and it survives a restart. Filtered to MCP actors so the panel is about the
 * machines rather than about someone clicking around the dashboard.
 */
keyRoutes.get("/partials/activity", (c) => {
  const page = parseInt(c.req.query("page") ?? "1", 10) || 1;
  const machine = c.req.query("machine") || null;
  const { rows, pages } = audit.recent(PAGE_SIZE, page, machine, "mcp:");
  return c.html(
    render("_activity.html", {
      rows,
      page: Math.min(Math.max(1, page), pages),
      pages,
      machine,
      computers: listComputers(),
    }),
  );
});
