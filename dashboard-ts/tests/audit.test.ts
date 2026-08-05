/**
 * The audit log.
 *
 * Coverage is the point. Because it is written by one middleware rather than by
 * calls inside handlers, the test that matters most is the one that sweeps
 * every mutating endpoint and insists each left a line — a log with holes is
 * worse than no log, because it reads as complete.
 */
import { beforeEach, expect, test } from "bun:test";
import { addMachine, del, get, patch, post, reset } from "./harness";
import { run } from "../src/db";
import * as audit from "../src/audit";

beforeEach(reset);

const add = async (name = "m1") => (await addMachine(name)).json.data.id;
const entries = async (params = "") =>
  (await get("/api/v1/audit" + (params ? `?${params}` : ""))).json.data;

test("a mutation is recorded with who, what and where", async () => {
  await add("recorded");
  const row = (await entries())[0];
  expect(row.action).toBe("POST /api/v1/computers");
  expect(row.actor).toBe("dashboard");
  expect(row.target).toBe("recorded");
  expect(row.status).toBe(201);
  expect(row.ok).toBe(1);
});

test("reads are not recorded", async () => {
  await add();
  const before = (await entries()).length;
  for (let i = 0; i < 5; i++) {
    await get("/api/v1/computers");
    await get("/partials/fleet");
  }
  expect((await entries()).length).toBe(before);
});

test("failures are recorded too", async () => {
  // A rejected attempt is exactly what you want to find later.
  await post("/api/v1/computers", { json: {} }); // no name -> 400
  const row = (await entries())[0];
  expect(row.status).toBe(400);
  expect(row.ok).toBe(0);
});

test("every mutating endpoint leaves a line", async () => {
  const id = await add();
  const calls: [string, string, any][] = [
    ["POST", `/api/v1/computers/${id}/exec`, { json: { command: "id" } }],
    ["POST", `/api/v1/computers/${id}/clipboard`, { json: { text: "x" } }],
    ["PATCH", `/api/v1/computers/${id}`, { json: { reserved: "1" } }],
    ["POST", `/api/v1/computers/${id}/sleep`, {}],
    ["POST", `/api/v1/computers/${id}/wake`, {}],
    ["POST", `/api/v1/computers/${id}/restart`, {}],
    ["POST", `/api/v1/computers/${id}/backups`, {}],
    ["POST", `/api/v1/computers/${id}/shares`, { json: { label: "x" } }],
    ["POST", `/api/v1/computers/${id}/rotate-password`, {}],
    ["POST", "/api/v1/tasks", { json: { desktop: "m1", description: "d" } }],
    ["DELETE", `/api/v1/computers/${id}`, {}],
  ];
  for (const [method, path, opts] of calls) {
    if (method === "POST") await post(path, opts);
    else if (method === "PATCH") await patch(path, opts);
    else await del(path, opts);
  }

  const logged = new Set((await entries("page=1")).map((e: any) => e.action));
  const missing = calls
    .map(([m, p]) => `${m} ${p}`)
    .filter((a) => !logged.has(a));
  expect(missing).toEqual([]);
});

test("the shell command is kept, because that is the point", async () => {
  const id = await add();
  await post(`/api/v1/computers/${id}/exec`, { json: { command: "rm -rf /var/tmp/something" } });
  const row = (await entries()).find((e: any) => e.action.endsWith("/exec"));
  expect(row.detail).toBe("rm -rf /var/tmp/something");
});

test("clipboard contents are counted, never stored", async () => {
  // An audit trail that quietly archives everything anyone pasted is its own
  // kind of problem.
  const id = await add();
  const secret = "correct horse battery staple";
  await post(`/api/v1/computers/${id}/clipboard`, { json: { text: secret } });
  const row = (await entries()).find((e: any) => e.action.endsWith("/clipboard"));
  expect(row.detail ?? "").not.toContain(secret);
  expect(row.detail).toContain("bytes");
});

test("filtering by machine", async () => {
  const a = await add("alpha");
  await add("beta");
  await post(`/api/v1/computers/${a}/sleep`);
  const rows = await entries("target=alpha");
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r: any) => r.target === "alpha")).toBe(true);
});

test("export is csv", async () => {
  await add();
  const r = await get("/api/v1/audit/export.csv");
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/csv");
  expect(r.text).toContain("POST /api/v1/computers");
});

test("retention drops old entries only", async () => {
  await add();
  run("UPDATE audit SET at = '2020-01-01T00:00:00+00:00'");
  audit.record("recent thing");
  const dropped = audit.prune();

  expect(dropped).toBeGreaterThanOrEqual(1);
  const remaining = (await entries()).map((e: any) => e.action);
  expect(remaining).toContain("recent thing");
  expect(remaining).not.toContain("POST /api/v1/computers");
});
