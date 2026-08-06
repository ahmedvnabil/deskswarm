/**
 * One MCP endpoint per machine: `POST /mcp/<slug>`, bearer key, that machine.
 *
 * The transport is MCP's Streamable HTTP, and this implements the stateless
 * half of it — every request carries its own authority and is answered on the
 * spot, with no session id and no server-initiated stream. That is a real
 * subset, not an accident: a session would be a second thing to expire, and
 * the tools here are all request/response anyway. `GET` (which opens the
 * server-to-client stream) is refused rather than left to hang, so a client
 * that wants one is told immediately instead of waiting for a timeout.
 *
 * Written against the protocol directly rather than an SDK, for the same
 * reason the rest of this codebase has four dependencies: the surface actually
 * in use here is `initialize`, `tools/list` and `tools/call`, and vendoring a
 * framework to express three methods buys less than it costs.
 *
 * Why the path names the machine when the key already implies it: so that a
 * misconfigured client fails loudly. Pointing a client at the wrong machine's
 * URL with a working key would otherwise silently drive the *right* machine
 * per the key while its config, its logs and the person reading them all say
 * otherwise.
 */

import { Hono, type Context } from "hono";
import * as audit from "./../audit";
import * as keys from "./../mcp/keys";
import { note } from "./../mcp/activity";
import { BridgeError, BridgeUnreachable } from "./../bridge";
import {
  ClipboardUnavailable,
  HomePathMissing,
  PathOutsideHome,
  providerFor,
} from "./../providers";
import {
  checkBridge,
  getComputer,
  touchActive,
  wakeAndWait,
  type Computer,
} from "./../machines";
import { one } from "./../db";
import { sourceIp, type Env } from "./../http";
import { ToolError, TOOLS_BY_NAME, runTool, toolManifest } from "./../mcp/tools";
import { MCP_AUTO_WAKE, MCP_CALL_TIMEOUT_SECONDS } from "./../settings";

export const mcpRoutes = new Hono<Env>();

/** The versions this speaks. The newest is what we answer with when a client
 *  asks for something we don't recognise — the spec's own guidance. */
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST = SUPPORTED[0];

const SERVER_VERSION = "2.0.0";

// ------------------------------------------------------------- JSON-RPC

type Id = string | number | null;

const result = (id: Id, value: unknown) => ({ jsonrpc: "2.0", id, result: value });

const error = (id: Id, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/**
 * A tool that failed is not a protocol failure.
 *
 * MCP draws this line deliberately: a JSON-RPC error means the client is
 * broken, while `isError` on a normal result means the *call* went wrong and
 * the model on the other end should read the message and try something else.
 * Sending the second as the first is how an agent ends up stuck instead of
 * self-correcting.
 */
const toolFailure = (message: string) => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

// ------------------------------------------------------------------ auth

interface Authorized {
  key: keys.KeyRow;
  comp: Computer;
}

/**
 * Resolve the bearer key and the machine it names, or explain the refusal.
 *
 * Every failure is a 401 with the same body except the mismatch, which is a
 * 403: the caller proved it holds a real key, so telling it that this key is
 * for another machine leaks nothing it did not already have.
 */
function authorize(c: Context<Env>): Authorized | Response {
  const slug = c.req.param("slug");
  const supplied = (c.req.header("authorization") || "")
    .replace(/^Bearer /i, "")
    .trim();

  const deny = (status: 401 | 403, message: string) =>
    c.json({ jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message } }, status, {
      "www-authenticate": 'Bearer realm="deskswarm"',
    });

  if (!supplied) return deny(401, "an MCP key is required");
  const key = keys.resolve(supplied);
  if (!key) return deny(401, "that key is unknown, revoked or expired");

  const comp = getComputer(key.computer_id);
  if (!comp) return deny(401, "the machine this key was issued for is gone");
  if (comp.slug !== slug) {
    return deny(
      403,
      `this key is for '${comp.slug}', not '${slug}' — point the client at ` +
        `/mcp/${comp.slug}`,
    );
  }
  return { key, comp };
}

// ----------------------------------------------------------------- errors

/**
 * Turn whatever a tool threw into a sentence the far end can act on.
 *
 * Each of these is a different instruction to the caller — wait, fix the path,
 * pick another approach — and flattening them into "internal error" is what
 * makes an agent retry the same failing call until it gives up.
 */
function explain(err: any, comp: Computer): string {
  if (err instanceof ToolError) return String(err.message);
  if (err instanceof BridgeUnreachable) {
    return `${comp.name} is not answering — it may still be waking up. ${err.message}`;
  }
  if (err instanceof BridgeError) return `${comp.name} refused: ${err.message}`;
  if (err instanceof PathOutsideHome) {
    return `${err.message}. Paths are relative to the machine's home directory.`;
  }
  if (err instanceof HomePathMissing) return `no such path: ${err.message}`;
  if (err instanceof ClipboardUnavailable) {
    return `the clipboard is not available on ${comp.name}: ${err.message}`;
  }
  return String(err?.message ?? err);
}

// ------------------------------------------------------------- dispatch

/**
 * Make sure the machine can actually take a call.
 *
 * An outside client has no sleep/wake button, so a machine that dozed off
 * would simply stop answering with nothing the client could do about it.
 * Waking on demand costs the first call a few seconds and makes idle-suspend
 * safe to leave on, which is the combination that lets a fleet be larger than
 * its memory.
 */
async function ensureAwake(comp: Computer): Promise<string | null> {
  const backend = providerFor(comp);
  // Ask Docker before the bridge. Probing a stopped machine's bridge burns the
  // full HTTP timeout to learn what the container state already says — the
  // same trap the wall hit once per tile per refresh.
  if (await backend.isRunning(comp.slug)) {
    const bridge = backend.bridgeEndpoint(comp.slug);
    if (await checkBridge({ bridge_host: bridge.host, bridge_port: bridge.port })) {
      return null;
    }
  }
  if (!MCP_AUTO_WAKE) {
    return `${comp.name} is asleep and DESKSWARM_MCP_AUTO_WAKE is off — wake it from the dashboard`;
  }
  const { ready } = await wakeAndWait(comp);
  return ready ? null : `${comp.name} would not wake up`;
}

async function callTool(
  c: Context<Env>,
  auth: Authorized,
  params: any,
): Promise<unknown> {
  const name = String(params?.name ?? "");
  const tool = TOOLS_BY_NAME.get(name);
  const { comp, key } = auth;

  if (!tool) {
    return toolFailure(
      `no tool called '${name}'. Available: ` +
        [...TOOLS_BY_NAME.keys()].join(", "),
    );
  }

  const args = (params?.arguments ?? {}) as Record<string, any>;
  const ip = sourceIp(c);
  // Recorded before the call, not after: a tool that hangs or kills the
  // machine is exactly the one you want to find in the log afterwards.
  const detail = summarise(name, args);
  let ok = true;
  let out: unknown;

  try {
    const asleep = await ensureAwake(comp);
    if (asleep) throw new ToolError(asleep);

    const bridge = providerFor(comp).bridgeEndpoint(comp.slug);
    out = {
      content: await runTool(
        tool,
        {
          comp,
          target: {
            slug: comp.slug,
            bridge_host: bridge.host,
            bridge_port: bridge.port,
          },
          timeoutMs: MCP_CALL_TIMEOUT_SECONDS * 1000,
        },
        args,
      ),
    };
  } catch (err: any) {
    ok = false;
    out = toolFailure(explain(err, comp));
  }

  keys.noteUse(key.id, name, ip || null);
  touchActive(comp.id);
  note(comp.name, name, key.label, ok);
  audit.record(`MCP ${name}`, {
    actor: `mcp:${key.label}`,
    source_ip: ip,
    target: comp.name,
    detail,
    status: ok ? 200 : 500,
    ok,
  });
  return out;
}

/**
 * A short, safe description of a call for the audit log.
 *
 * The same rule the rest of the log follows: the shell command is recorded
 * because that is the point of having it, and everything that is content —
 * what was typed, what was written to a file, what went on the clipboard — is
 * counted rather than kept.
 */
function summarise(name: string, args: Record<string, any>): string {
  if (name === "shell") return String(args.command ?? "").slice(0, 500);
  if (name === "type_text" || name === "set_clipboard") {
    return `${Buffer.byteLength(String(args.text ?? ""), "utf8")} bytes`;
  }
  if (name === "write_file") {
    return `${args.path} (${Buffer.byteLength(String(args.content ?? ""), "utf8")} bytes)`;
  }
  if (name === "read_file" || name === "list_files") return String(args.path ?? "~");
  if (name === "launch_app") return String(args.app ?? "");
  if (name === "hotkey") return (args.keys ?? []).join("+");
  if (name === "press_key") return String(args.key ?? "");
  if (["click", "double_click", "move_mouse"].includes(name)) {
    return `${args.x},${args.y}`;
  }
  if (name === "drag") return `${args.from_x},${args.from_y} -> ${args.to_x},${args.to_y}`;
  if (name === "scroll") return `${args.direction} ${args.clicks ?? 3}`;
  return "";
}

async function handle(
  c: Context<Env>,
  auth: Authorized,
  message: any,
): Promise<unknown | null> {
  if (message?.jsonrpc !== "2.0") {
    return error(message?.id ?? null, INVALID_REQUEST, "jsonrpc must be '2.0'");
  }
  const { id, method, params } = message;
  // A notification has no id and takes no reply — including for methods we do
  // not implement, which is what makes an unknown notification harmless.
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const asked = String(params?.protocolVersion ?? "");
      return result(id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : LATEST,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: `deskswarm/${auth.comp.slug}`,
          title: `${auth.comp.name} — a Linux desktop`,
          version: SERVER_VERSION,
        },
        instructions:
          `You are connected to '${auth.comp.name}', a full XFCE Linux desktop ` +
          `running in a container. You have its screen, its keyboard and mouse, ` +
          `a root shell, and its home directory.\n\n` +
          `Take a screenshot first — every coordinate comes off that image. ` +
          `Prefer 'shell' over driving the GUI when both would work; it is ` +
          `faster and it does not depend on what is on screen. The machine is ` +
          `yours to change: install what you need.`,
      });
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return isNotification ? null : result(id, {});

    case "tools/list":
      return result(id, { tools: toolManifest() });

    case "tools/call": {
      if (isNotification) return null; // a call with no id has nowhere to answer
      return result(id, await callTool(c, auth, params));
    }

    // Advertised in neither capabilities nor the manifest, but clients probe
    // for them on connect; an empty list is a cheaper answer than an error.
    case "resources/list":
      return result(id, { resources: [] });
    case "prompts/list":
      return result(id, { prompts: [] });

    default:
      if (isNotification) return null;
      return error(id, METHOD_NOT_FOUND, `unknown method '${method}'`);
  }
}

// ------------------------------------------------------------------ routes

mcpRoutes.post("/mcp/:slug", async (c) => {
  const auth = authorize(c);
  if (auth instanceof Response) return auth;

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(error(null, PARSE_ERROR, "body is not JSON"), 400);
  }

  // A batch is a JSON array. Notifications inside it produce no reply, so a
  // batch of nothing but notifications correctly answers 202 with no body.
  const batch = Array.isArray(body);
  const messages = batch ? body : [body];
  if (batch && !messages.length) {
    return c.json(error(null, INVALID_REQUEST, "empty batch"), 400);
  }

  const replies: unknown[] = [];
  for (const message of messages) {
    let reply: unknown | null;
    try {
      reply = await handle(c, auth, message);
    } catch (err: any) {
      // Reaching here means a bug in this file rather than a failed tool call
      // — those are caught and returned as isError results well before now.
      console.error("mcp:", err);
      reply = error(
        message?.id ?? null,
        INTERNAL_ERROR,
        String(err?.message ?? err),
      );
    }
    if (reply !== null) replies.push(reply);
  }

  if (!replies.length) return c.body(null, 202);
  return c.json(batch ? replies : replies[0]);
});

/** The server-to-client stream. Nothing here pushes, so say so rather than
 *  holding a connection open that will never carry anything. */
mcpRoutes.get("/mcp/:slug", (c) =>
  c.json(error(null, METHOD_NOT_FOUND, "this endpoint does not open a stream"), 405),
);

/** Session teardown. There is no session, so there is nothing to tear down —
 *  and a client that tries should not see a 404 and conclude it is lost. */
mcpRoutes.delete("/mcp/:slug", (c) => c.body(null, 204));

/**
 * A machine's endpoint, discoverable without a key.
 *
 * Only what someone holding a key needs to configure a client, and nothing
 * that is not already implied by knowing the URL: whether the slug names a
 * real machine, and which protocol versions it speaks.
 */
mcpRoutes.get("/mcp/:slug/info", (c) => {
  const slug = c.req.param("slug");
  const comp = one<Computer>("SELECT * FROM computers WHERE slug = ?", slug);
  if (!comp) return c.json({ ok: false, data: null, error: "not found" }, 404);
  return c.json({
    ok: true,
    error: null,
    data: {
      machine: comp.name,
      slug: comp.slug,
      transport: "streamable-http",
      protocol_versions: SUPPORTED,
      tools: toolManifest().map((t) => t.name),
    },
  });
});

export { SUPPORTED as MCP_PROTOCOL_VERSIONS };
