/**
 * Render every template once, with data in it.
 *
 * The port from Jinja2 to nunjucks is mostly mechanical, and the parts that
 * are not — Python slices, `is not none`, an empty list being falsy — fail
 * only when a template is actually rendered with the shape of data that
 * exercises them. Two of these were found in production rather than here,
 * which is what this file is for.
 */
import { beforeEach, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { addMachine, get, post, reset } from "./harness";
import { render } from "../src/templates";
import { nowIso } from "../src/settings";

beforeEach(reset);

const machine = {
  id: 1,
  name: "alpha",
  slug: "alpha",
  novnc_port: 6901,
  novnc_url: "http://localhost:6901/vnc.html",
  vnc_password: "secret",
  bridge_host: "b",
  bridge_port: 8000,
  created_at: nowIso(),
  reserved: false,
  no_suspend: false,
  last_active_at: nowIso(),
  bridge_ok: true,
  sleeping: false,
  desktop_state: "running",
  bridge_state: "running",
  activity: { tool: "click", label: "claude code", ok: true, seconds_ago: 4 },
};

const mcpKey = {
  id: 1, computer_id: 1, token: "dsk_abc", label: "claude code",
  expires_at: nowIso(), revoked: 0, calls: 12, last_used_at: nowIso(),
  last_used_ip: "127.0.0.1", last_tool: "screenshot", created_at: nowIso(),
  status: "live", computer: "alpha", slug: "alpha",
  url: "http://localhost/mcp/alpha", claude_code: "claude mcp add ...",
};

const share = {
  id: 1, computer_id: 1, token: "t", label: "sara", mode: "watch",
  expires_at: nowIso(), revoked: 0, uses: 1, last_used_at: nowIso(),
  last_used_ip: "127.0.0.1", created_at: nowIso(), status: "live",
};

/** Both shapes every template has to survive: full, and completely empty. */
const contexts: Record<string, [full: object, empty: object]> = {
  "index.html": [{ computers: [machine], actor: "sara" }, { computers: [], actor: null }],
  "_fleet.html": [{ computers: [machine], shot_token: 1 }, { computers: [], shot_token: 1 }],
  "_guards.html": [
    { g: { memory_available_mb: 900, memory_source: "meminfo", disk_free_gb: 12,
           machines_in_use: 2, blocking: ["stopped"],
           warnings: ["8 GB of disk left"], ok: false } },
    { g: { memory_available_mb: null, memory_source: "budget", disk_free_gb: null,
           machines_in_use: 0, blocking: [], warnings: [], ok: true } },
  ],
  "_access.html": [
    { comp: machine, url: "http://localhost/mcp/alpha", keys: [mcpKey, { ...mcpKey, id: 2, status: "revoked" }],
      tools: [{ name: "screenshot", description: "take a picture" }],
      recent: [{ machine: "alpha", tool: "click", label: "claude code", ok: true, at: 0 }] },
    { comp: machine, url: "http://localhost/mcp/alpha", keys: [], tools: [], recent: [] },
  ],
  "_activity.html": [
    { rows: [{ id: 1, at: nowIso(), actor: "mcp:claude code", source_ip: "10.0.0.1",
               action: "MCP screenshot", target: "alpha", detail: "", status: 200, ok: 1 },
             { id: 2, at: nowIso(), actor: "mcp:bot", source_ip: null,
               action: "MCP shell", target: "alpha", detail: "ls -la", status: 500, ok: 0 }],
      pages: 2, page: 1, machine: "alpha", computers: [machine] },
    { rows: [], pages: 1, page: 1, machine: null, computers: [] },
  ],
  "_audit.html": [
    { rows: [{ id: 1, at: nowIso(), actor: "share:sara", source_ip: "10.0.0.1",
               action: "GET /s/<token>", target: "alpha", detail: "opened", status: 200, ok: 1 },
             { id: 2, at: nowIso(), actor: "dashboard", source_ip: null,
               action: "POST /api/v1/computers/1/keys", target: null, detail: null, status: 400, ok: 0 }],
      pages: 2, page: 1, target: "alpha", names: ["alpha"] },
    { rows: [], pages: 1, page: 1, target: "", names: [] },
  ],
  "_backups.html": [
    { comp: machine, rows: [{ name: "20260805T000000Z.tar.gz", bytes: 1048576, created_at: nowIso() }],
      keep: 5, daily_at: "03:00" },
    { comp: machine, rows: [], keep: 0, daily_at: "" },
  ],
  "_files.html": [
    { comp: machine, entries: [{ name: "Desktop", type: "dir", size: 0 },
                               { name: "notes.txt", type: "file", size: 2048 }],
      path: "Desktop", parent: "", error: null, max_mb: 64 },
    { comp: machine, entries: [], path: "", parent: null, error: "boom", max_mb: 64 },
  ],
  "_inventory.html": [
    { comp: machine, vnc_password: "secret",
      inv: { os: "Debian", kernel: "6.1", runtimes: [{ name: "python3", version: "3.12" }],
             apps: ["firefox"], package_count: 500, python_packages: ["pip==24"],
             disk: "/dev/sda 20G 5G 15G 25% /", memory: "2G total, 1G used, 1G available" } },
    { comp: machine, vnc_password: "secret", inv: { error: "unreachable" } },
  ],
  "share.html": [
    { comp: machine, view: machine, share: { ...share, mode: "control" }, token: "t" },
    { comp: machine, view: { ...machine, sleeping: true }, share, token: "t" },
  ],
  "share_gone.html": [{}, {}],
  "login.html": [
    { next: "/partials/fleet", username: "sara", error: "wrong username or password", session_days: 14 },
    { next: "/", username: "", error: null, session_days: 14 },
  ],
};

test("every template file has a case here", () => {
  const files = readdirSync("templates").filter((f) => f.endsWith(".html")).sort();
  expect(files).toEqual(Object.keys(contexts).sort());
});

for (const [name, [full, empty]] of Object.entries(contexts)) {
  test(`${name} renders with data`, () => {
    expect(render(name, full as any).length).toBeGreaterThan(0);
  });
  test(`${name} renders empty`, () => {
    expect(render(name, empty as any).length).toBeGreaterThan(0);
  });
}

test("the access panel shows the key but never its hash", () => {
  // The token is deliberately shown — a key you cannot read again is one people
  // store somewhere worse. The hash is an implementation detail, and printing
  // it invites someone to paste it in as the credential.
  const html = render("_access.html", contexts["_access.html"][0] as any);
  expect(html).toContain("dsk_abc");
  expect(html).toContain("/mcp/alpha");
  expect(html).not.toContain("token_hash");
});

test("a revoked key offers no revoke button", () => {
  const html = render("_access.html", contexts["_access.html"][0] as any);
  // One live key, one revoked: exactly one button, and the dead one's token
  // is not reprinted next to it.
  expect(html.match(/>revoke</g)?.length).toBe(1);
});

test("an empty fleet still shows its empty state", async () => {
  // The Jinja original relied on an empty list being falsy, which it is not in
  // JavaScript — without the port's explicit length check this silently
  // rendered a wall with no tiles and no message.
  const r = await get("/partials/fleet");
  expect(r.text).toContain("No machines yet");
});

test("a populated partial names the machine", async () => {
  await addMachine("alpha");
  expect((await get("/partials/fleet")).text).toContain("alpha");
});

test("every partial route answers", async () => {
  const id = (await addMachine("alpha")).json.data.id;
  await post(`/api/v1/computers/${id}/keys`, { json: { label: "sara" } });
  await post(`/api/v1/computers/${id}/shares`, { json: { label: "sara" } });

  for (const path of [
    "/partials/fleet", "/partials/activity", "/partials/guards", "/partials/audit",
    `/partials/computers/${id}/files`, `/partials/computers/${id}/backups`,
    `/partials/computers/${id}/inventory`, `/partials/computers/${id}/access`,
  ]) {
    const r = await get(path);
    expect(`${path} -> ${r.status}`).toBe(`${path} -> 200`);
  }
});

test("the wall's tiles are not lazy", () => {
  // The wall replaces its own DOM every five seconds. A lazy image is fetched
  // only after a layout pass decides it is near the viewport, and the element
  // is gone before that — so every tile stayed blank, on every browser, in
  // both the Flask original and this port. Nothing to defer either: the tiles
  // are the page.
  const html = render("_fleet.html", contexts["_fleet.html"][0] as any);
  expect(html).toContain("/screenshot?t=");
  expect(html).not.toContain('loading="lazy"');
});
