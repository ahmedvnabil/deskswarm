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
  active_task: { id: 3, description: "do a thing", status: "RUNNING", current_action: "click" },
};

const share = {
  id: 1, computer_id: 1, token: "t", label: "sara", mode: "watch",
  expires_at: nowIso(), revoked: 0, uses: 1, last_used_at: nowIso(),
  last_used_ip: "127.0.0.1", created_at: nowIso(), status: "live",
};

/** Both shapes every template has to survive: full, and completely empty. */
const contexts: Record<string, [full: object, empty: object]> = {
  "index.html": [{ computers: [machine] }, { computers: [] }],
  "_fleet.html": [{ computers: [machine], shot_token: 1 }, { computers: [], shot_token: 1 }],
  "_guards.html": [
    { g: { spend_today_usd: 1.5, daily_cost_limit_usd: 10, memory_available_mb: 900,
           memory_source: "meminfo", disk_free_gb: 12, consecutive_failures: 2,
           blocking: ["stopped"], warnings: ["8 GB of disk left"], ok: false } },
    { g: { spend_today_usd: 0, daily_cost_limit_usd: null, memory_available_mb: null,
           memory_source: "budget", disk_free_gb: null, consecutive_failures: 0,
           blocking: [], warnings: [], ok: true } },
  ],
  "_tasks.html": [
    { tasks: [{ id: 1, desktop: "alpha", description: "x", status: "COMPLETED",
                result_text: "done", cost_usd: 0.12, duration_seconds: 3.5,
                error: null, created_at: nowIso(), updated_at: nowIso() },
              { id: 2, desktop: "alpha", description: "y", status: "RUNNING",
                current_action: "type", cost_usd: null, duration_seconds: null,
                created_at: nowIso(), updated_at: nowIso() }],
      names: ["alpha"], sel_desktop: "alpha", sel_status: "", page: 1, pages: 3, total: 2 },
    { tasks: [], names: [], sel_desktop: "", sel_status: "", page: 1, pages: 1, total: 0 },
  ],
  "_analytics.html": [
    { analytics: { total: 4, by_status: { PENDING: 1, RUNNING: 1, COMPLETED: 1, FAILED: 1, CANCELLED: 0 },
                   success_rate: 50.0, total_cost_usd: 1.2345, avg_duration_seconds: 12.3,
                   per_desktop: [{ name: "alpha", total: 2, completed: 1, failed: 1, cost_usd: 1.2, exists: true }],
                   daily: [{ day: "2026-08-05", count: 2, cost: 0.5 }] } },
    { analytics: { total: 0, by_status: { PENDING: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0 },
                   success_rate: null, total_cost_usd: 0, avg_duration_seconds: null,
                   per_desktop: [], daily: [] } },
  ],
  "_schedules.html": [
    { schedules: [{ id: 1, desktop: "alpha", description: "ping", kind: "interval",
                    every_minutes: 15, at_time: null, enabled: 1,
                    next_run_at: nowIso(), last_run_at: nowIso(), run_count: 3 },
                  { id: 2, desktop: "all", description: "nightly", kind: "daily",
                    every_minutes: null, at_time: "03:00", enabled: 0,
                    next_run_at: nowIso(), last_run_at: null, run_count: 0 }] },
    { schedules: [] },
  ],
  "_audit.html": [
    { rows: [{ id: 1, at: nowIso(), actor: "share:sara", source_ip: "10.0.0.1",
               action: "GET /s/<token>", target: "alpha", detail: "opened", status: 200, ok: 1 },
             { id: 2, at: nowIso(), actor: "dashboard", source_ip: null,
               action: "POST /api/v1/tasks", target: null, detail: null, status: 400, ok: 0 }],
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

test("the task status filter keeps all five options", () => {
  // Jinja's `for v, label in [('a','b'), …]` unpacks a list of tuples;
  // nunjucks has no tuples and walked the strings instead, producing options
  // whose value was a single letter. The page still rendered, which is why the
  // only thing that caught it was comparing output with the Flask original.
  const html = render("_tasks.html", contexts["_tasks.html"][1] as any);
  for (const [value, label] of [
    ["", "any status"], ["ACTIVE", "in flight"], ["COMPLETED", "completed"],
    ["FAILED", "failed"], ["CANCELLED", "cancelled"],
  ]) {
    expect(html).toContain(`value="${value}"`);
    expect(html).toContain(`>${label}</option>`);
  }
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
  await post("/api/v1/schedules", {
    json: { desktop: "alpha", description: "ping", kind: "interval", every_minutes: 15 },
  });
  await post(`/api/v1/computers/${id}/shares`, { json: { label: "sara" } });

  for (const path of [
    "/partials/fleet", "/partials/tasks", "/partials/analytics",
    "/partials/guards", "/partials/schedules", "/partials/audit",
    `/partials/computers/${id}/files`, `/partials/computers/${id}/backups`,
    `/partials/computers/${id}/inventory`,
  ]) {
    const r = await get(path);
    expect(`${path} -> ${r.status}`).toBe(`${path} -> 200`);
  }
});
