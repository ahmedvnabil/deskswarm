/**
 * The MCP endpoint: who gets in, what they can do, and what it leaves behind.
 *
 * The bearer checks get the most attention here because a key is the whole of
 * an outside client's authority — there is no second gate behind it, and the
 * thing on the far side is a root shell on somebody's machine.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  addMachine,
  bridgeLog,
  callTool,
  clipboards,
  execLog,
  get,
  issueKey,
  mcp,
  pasted,
  post,
  del,
  reset,
  world,
} from "./harness";

let id: number;
let token: string;

beforeEach(async () => {
  reset();
  id = (await addMachine("m1")).json.data.id;
  token = (await issueKey(id, "claude code")).json.data.token;
});

// ------------------------------------------------------------------- auth

describe("getting in", () => {
  test("no key is refused", async () => {
    const r = await mcp("m1", "", "tools/list");
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("Bearer");
  });

  test("a made-up key is refused", async () => {
    expect((await mcp("m1", "dsk_nope", "tools/list")).status).toBe(401);
  });

  test("a revoked key stops working", async () => {
    const keyId = (await get("/api/v1/keys")).json.data[0].id;
    expect((await mcp("m1", token, "tools/list")).status).toBe(200);
    await del(`/api/v1/keys/${keyId}`);
    expect((await mcp("m1", token, "tools/list")).status).toBe(401);
  });

  /**
   * The case the path exists to catch.
   *
   * Without it a client pointed at the wrong machine would quietly drive the
   * right one per its key, while its config and every log line said otherwise.
   */
  test("a key for another machine is refused at this one", async () => {
    const other = (await addMachine("m2")).json.data.id;
    const otherToken = (await issueKey(other)).json.data.token;
    const r = await mcp("m1", otherToken, "tools/list");
    expect(r.status).toBe(403);
    expect(r.json.error.message).toContain("m2");
  });

  test("an expired key stops working", async () => {
    // Issued for a day, then aged past it.
    const { run } = await import("../src/db");
    const { nowIso } = await import("../src/settings");
    run(
      "UPDATE mcp_keys SET expires_at = ?",
      nowIso(new Date(Date.now() - 60_000)),
    );
    expect((await mcp("m1", token, "tools/list")).status).toBe(401);
  });

  test("a key with no expiry keeps working", async () => {
    const forever = (await issueKey(id, "forever", 0)).json.data;
    expect(forever.expires_at).toBeNull();
    expect((await mcp("m1", forever.token, "tools/list")).status).toBe(200);
  });

  test("the session cookie is not a way in", async () => {
    // The bearer check must stand on its own: a signed-in browser is not an
    // MCP client, and letting the cookie through would mean any page the user
    // visits could drive their machines.
    const r = await get("/mcp/m1");
    expect(r.status).toBe(405);
  });
});

// --------------------------------------------------------------- protocol

describe("the protocol", () => {
  test("initialize names the machine and agrees a version", async () => {
    const r = await mcp("m1", token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(r.status).toBe(200);
    expect(r.json.result.protocolVersion).toBe("2025-06-18");
    expect(r.json.result.serverInfo.name).toBe("deskswarm/m1");
    expect(r.json.result.capabilities.tools).toBeDefined();
    expect(r.json.result.instructions).toContain("m1");
  });

  test("an unknown protocol version falls back to the newest we speak", async () => {
    const r = await mcp("m1", token, "initialize", { protocolVersion: "1999-01-01" });
    expect(r.json.result.protocolVersion).toBe("2025-06-18");
  });

  test("tools/list advertises a schema for every tool", async () => {
    const tools = (await mcp("m1", token, "tools/list")).json.result.tools;
    expect(tools.length).toBeGreaterThan(10);
    for (const t of tools) {
      expect(typeof t.name).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe("object");
    }
    expect(tools.map((t: any) => t.name)).toContain("screenshot");
  });

  test("a notification gets 202 and no body", async () => {
    const r = await mcp("m1", token, "notifications/initialized", undefined, null);
    expect(r.status).toBe(202);
    expect(r.text).toBe("");
  });

  test("an unknown method is a JSON-RPC error, and keeps the id", async () => {
    const r = await mcp("m1", token, "nonsense/method", undefined, 77);
    expect(r.json.id).toBe(77);
    expect(r.json.error.code).toBe(-32601);
  });

  test("an unknown notification is silently fine", async () => {
    // A notification has nowhere to send an error, so answering one with a
    // body is worse than ignoring it.
    const r = await mcp("m1", token, "notifications/whatever", undefined, null);
    expect(r.status).toBe(202);
  });

  test("a batch answers only the calls that have ids", async () => {
    const r = await post("/mcp/m1", {
      json: [
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
      headers: { authorization: `Bearer ${token}` },
      noCookie: true,
    });
    expect(r.json.length).toBe(2);
    expect(r.json.map((m: any) => m.id)).toEqual([1, 2]);
  });

  test("a malformed body is a parse error", async () => {
    const r = await post("/mcp/m1", {
      body: "{not json",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      noCookie: true,
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32700);
  });

  test("the info endpoint needs no key", async () => {
    const r = await get("/mcp/m1/info");
    expect(r.status).toBe(200);
    expect(r.json.data.machine).toBe("m1");
    expect(r.json.data.tools).toContain("shell");
    // It must not leak anything a key would have bought.
    expect(r.text).not.toContain(token);
  });
});

// ------------------------------------------------------------------ tools

describe("driving the machine", () => {
  test("screenshot comes back as an image, not text", async () => {
    const { result } = await callTool("m1", token, "screenshot");
    expect(result.content[0].type).toBe("image");
    expect(result.content[0].mimeType).toBe("image/png");
    expect(result.isError).toBeUndefined();
  });

  test("click becomes a left_click at the point given", async () => {
    await callTool("m1", token, "click", { x: 100, y: 250 });
    expect(bridgeLog.at(-1)).toEqual(["left_click", { x: 100, y: 250 }]);
  });

  test("the button chooses the command", async () => {
    await callTool("m1", token, "click", { x: 1, y: 2, button: "right" });
    expect(bridgeLog.at(-1)![0]).toBe("right_click");
  });

  test("a drag sets its start point before dragging", async () => {
    // drag_to starts wherever the pointer happens to be, so without this the
    // drag begins from whatever the previous call left behind.
    await callTool("m1", token, "drag", { from_x: 5, from_y: 6, to_x: 50, to_y: 60 });
    expect(bridgeLog.map((b) => b[0])).toEqual(["move_cursor", "drag_to"]);
    expect(bridgeLog[0][1]).toEqual({ x: 5, y: 6 });
    expect(bridgeLog[1][1].x).toBe(50);
  });

  test("shell runs the command and reports the exit code", async () => {
    const { result } = await callTool("m1", token, "shell", { command: "uname -a" });
    expect(execLog).toContain("uname -a");
    expect(result.content[0].text).toContain("exit 0");
  });

  test("latin text is typed", async () => {
    await callTool("m1", token, "type_text", { text: "hello" });
    expect(bridgeLog.at(-1)).toEqual(["type_text", { text: "hello" }]);
    expect(pasted.length).toBe(0);
  });

  /**
   * Typing goes through keysym lookup, which drops most non-Latin-1
   * characters — Arabic types as nothing at all, with no error. The clipboard
   * carries bytes, so for that text it is not a fallback but the only path.
   */
  test("arabic text goes through the clipboard instead", async () => {
    await callTool("m1", token, "type_text", { text: "مرحبا" });
    expect(pasted.at(-1)).toEqual(["m1", "مرحبا"]);
    expect(bridgeLog.some((b) => b[0] === "type_text")).toBe(false);
  });

  test("files round-trip through the home directory", async () => {
    await callTool("m1", token, "write_file", { path: "notes.txt", content: "hi" });
    const { result } = await callTool("m1", token, "read_file", { path: "notes.txt" });
    expect(result.content[0].text).toBe("hi");
  });

  test("a path that climbs out of home is refused", async () => {
    const { result } = await callTool("m1", token, "read_file", { path: "../../etc/shadow" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("outside");
  });

  test("the clipboard round-trips", async () => {
    await callTool("m1", token, "set_clipboard", { text: "copied" });
    expect(clipboards.get("m1")).toBe("copied");
    const { result } = await callTool("m1", token, "get_clipboard");
    expect(result.content[0].text).toBe("copied");
  });
});

// ----------------------------------------------------------------- errors

describe("when things go wrong", () => {
  /**
   * MCP draws this line deliberately: a JSON-RPC error means the client is
   * broken, `isError` means the call went wrong and the model should read the
   * message and try something else. Sending the second as the first is how an
   * agent gets stuck instead of correcting itself.
   */
  test("an unknown tool is a tool error, not a protocol error", async () => {
    const r = await mcp("m1", token, "tools/call", { name: "teleport", arguments: {} });
    expect(r.json.error).toBeUndefined();
    expect(r.json.result.isError).toBe(true);
    expect(r.json.result.content[0].text).toContain("screenshot");
  });

  test("bad arguments are a tool error too", async () => {
    const { result } = await callTool("m1", token, "click", { x: "over there" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("must be a number");
  });

  test("a machine that refuses says why", async () => {
    world.bridgeRefuses = "no such window";
    const { result } = await callTool("m1", token, "click", { x: 1, y: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no such window");
  });

  test("a machine that will not wake is reported, not hung", async () => {
    world.bridgeUp = false;
    process.env.DESKSWARM_WAKE_TIMEOUT = "0.01";
    await post(`/api/v1/computers/${id}/sleep`);
    const { result } = await callTool("m1", token, "screenshot");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("wake");
  });
});

// ------------------------------------------------------------- monitoring

describe("what it leaves behind", () => {
  test("every call is audited against the machine and the client", async () => {
    await callTool("m1", token, "shell", { command: "whoami" });
    const rows = (await get("/api/v1/audit")).json.data;
    const row = rows.find((r: any) => r.action === "MCP shell");
    expect(row.actor).toBe("mcp:claude code");
    expect(row.target).toBe("m1");
    expect(row.detail).toBe("whoami");
  });

  /**
   * The same rule the rest of the audit log follows: the shell command is
   * kept because that is the point of having it, and anything that is content
   * is counted rather than stored.
   */
  test("typed text is counted, not recorded", async () => {
    await callTool("m1", token, "type_text", { text: "hunter2" });
    const rows = (await get("/api/v1/audit")).json.data;
    const row = rows.find((r: any) => r.action === "MCP type_text");
    expect(row.detail).toBe("7 bytes");
    expect(JSON.stringify(rows)).not.toContain("hunter2");
  });

  test("a failed call is audited as failed", async () => {
    world.bridgeRefuses = "nope";
    await callTool("m1", token, "click", { x: 1, y: 1 });
    const row = (await get("/api/v1/audit")).json.data.find(
      (r: any) => r.action === "MCP click",
    );
    expect(row.ok).toBe(0);
  });

  test("the key counts its own use", async () => {
    await callTool("m1", token, "screenshot");
    await callTool("m1", token, "screen_size");
    const key = (await get("/api/v1/keys")).json.data[0];
    expect(key.calls).toBe(2);
    expect(key.last_tool).toBe("screen_size");
    expect(key.last_used_at).not.toBeNull();
  });

  test("a machine in use is shown as in use on the wall", async () => {
    expect((await get("/partials/fleet")).text).not.toContain("data-state=\"busy\"");
    await callTool("m1", token, "click", { x: 1, y: 1 });
    const html = (await get("/partials/fleet")).text;
    expect(html).toContain('data-state="busy"');
    expect(html).toContain("click");
  });

  test("the activity panel shows the call", async () => {
    await callTool("m1", token, "shell", { command: "ls" });
    const html = (await get("/partials/activity")).text;
    expect(html).toContain("claude code");
    expect(html).toContain("shell");
  });
});

// --------------------------------------------------------------- lifecycle

describe("keys and machines", () => {
  test("deleting a machine deletes its keys", async () => {
    expect((await get("/api/v1/keys")).json.data.length).toBe(1);
    await del(`/api/v1/computers/${id}`);
    expect((await get("/api/v1/keys")).json.data.length).toBe(0);
  });

  /**
   * The id a deleted machine used is free to be reissued by SQLite's
   * AUTOINCREMENT-less rowid reuse, so a key left pointing at it would come
   * back to life aimed at a machine nobody meant to share.
   */
  test("a key does not survive its machine to reach the next one", async () => {
    await del(`/api/v1/computers/${id}`);
    const next = (await addMachine("m2")).json.data.id;
    const r = await mcp("m2", token, "tools/list");
    expect(r.status).toBe(401);
    expect(next).toBeDefined();
  });

  test("the issued key carries a ready-to-paste client command", async () => {
    const key = (await get("/api/v1/keys")).json.data[0];
    expect(key.claude_code).toContain("claude mcp add");
    expect(key.claude_code).toContain("/mcp/m1");
    expect(key.claude_code).toContain(key.token);
  });

  test("an over-long expiry is refused", async () => {
    const r = await post(`/api/v1/computers/${id}/keys`, {
      json: { label: "x", days: 100000 },
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("expiry");
  });
});
