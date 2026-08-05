/**
 * Sleeping frees a machine's memory; waking brings it back.
 *
 * The rules that matter here are the ones that protect work in progress: a
 * machine running a task must not be suspended, and a machine someone is
 * watching must not be either.
 */
import { beforeEach, expect, test } from "bun:test";
import { addMachine, created, get, patch, post, reset, world } from "./harness";
import { run } from "../src/db";
import { nowIso } from "../src/settings";
import { idleTick } from "../src/scheduler";
import { budgetedMachineCount } from "../src/machines";

beforeEach(reset);

const add = async (name = "m1") => {
  const r = await addMachine(name);
  expect(r.status).toBe(201);
  return r.json.data.id;
};

async function view(id: number) {
  const found = (await get("/api/v1/computers")).json.data.find((c: any) => c.id === id);
  if (!found) throw new Error("machine vanished");
  return found;
}

const stale = (id: number, minutes: number) =>
  run(
    "UPDATE computers SET last_active_at = ? WHERE id = ?",
    nowIso(new Date(Date.now() - minutes * 60_000)),
    id,
  );

test("sleep then wake round-trips", async () => {
  const id = await add();
  expect((await view(id)).sleeping).toBe(false);

  expect((await post(`/api/v1/computers/${id}/sleep`)).status).toBe(200);
  expect((await view(id)).sleeping).toBe(true);

  expect((await post(`/api/v1/computers/${id}/wake`)).status).toBe(200);
  expect((await view(id)).sleeping).toBe(false);
});

test("a sleeping machine reports no screen", async () => {
  // The wall must not spend a bridge timeout per tile on stopped machines.
  const id = await add();
  await post(`/api/v1/computers/${id}/sleep`);
  const r = await get(`/api/v1/computers/${id}/screenshot`);
  expect(r.status).toBe(503);
  expect(r.json.error).toBe("sleeping");
});

test("sleep is refused while a task is running", async () => {
  const id = await add();
  await post("/api/v1/tasks", { json: { desktop: "m1", description: "work" } });
  const r = await post(`/api/v1/computers/${id}/sleep`);
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("running");
  expect((await view(id)).sleeping).toBe(false);
});

test("the idle sweep is off by default", async () => {
  // Suspending costs someone their open windows, so it has to be opted in.
  const id = await add();
  await idleTick();
  expect((await view(id)).sleeping).toBe(false);
});

test("the idle sweep suspends only after the timeout", async () => {
  process.env.DESKSWARM_IDLE_SUSPEND_MINUTES = "30";
  const id = await add();

  stale(id, 5);
  await idleTick();
  expect((await view(id)).sleeping).toBe(false); // 5 minutes idle is not idle

  stale(id, 45);
  await idleTick();
  expect((await view(id)).sleeping).toBe(true);
});

test("the idle sweep spares a watched machine", async () => {
  // Someone with the screen open is using it, however long since a task.
  process.env.DESKSWARM_IDLE_SUSPEND_MINUTES = "30";
  world.watchers = 1;
  const id = await add();
  stale(id, 120);
  await idleTick();
  expect((await view(id)).sleeping).toBe(false);
});

test("the idle sweep spares a busy machine", async () => {
  process.env.DESKSWARM_IDLE_SUSPEND_MINUTES = "30";
  const id = await add();
  stale(id, 120);
  await post("/api/v1/tasks", { json: { desktop: "m1", description: "long job" } });
  await idleTick();
  expect((await view(id)).sleeping).toBe(false);
});

test("the no_suspend flag is honoured", async () => {
  process.env.DESKSWARM_IDLE_SUSPEND_MINUTES = "30";
  const id = await add();
  expect((await patch(`/api/v1/computers/${id}`, { json: { no_suspend: "1" } })).status).toBe(200);
  stale(id, 999);
  await idleTick();
  expect((await view(id)).sleeping).toBe(false);
  expect((await view(id)).no_suspend).toBe(true);
});

test("the first sweep starts the clock instead of suspending", async () => {
  // Turning the feature on must not stop every machine at the next tick.
  process.env.DESKSWARM_IDLE_SUSPEND_MINUTES = "30";
  const id = await add();
  run("UPDATE computers SET last_active_at = NULL WHERE id = ?", id);
  await idleTick();
  expect((await view(id)).sleeping).toBe(false);
  expect((await view(id)).last_active_at).not.toBeNull();
});

test("sleeping machines do not spend the memory budget", async () => {
  // A sleeping machine costs nothing, so charging the budget for it would
  // refuse new machines while the RAM it supposedly holds sits free.
  for (const n of ["m1", "m2", "m3"]) await add(n);
  expect(await budgetedMachineCount()).toBe(3);

  await post(`/api/v1/computers/${await add("m4")}/sleep`);
  expect(await budgetedMachineCount()).toBe(3);
});

test("wake recreates a bridge that will not come back", async () => {
  // A started container keeps its old filesystem, and things that refuse to
  // start twice live there — stale X locks, sockets, pid files.
  const id = await add();
  await post(`/api/v1/computers/${id}/sleep`);

  world.bridgeUp = false;
  process.env.DESKSWARM_WAKE_TIMEOUT = "0.01";
  created.clear();

  const r = await post(`/api/v1/computers/${id}/wake`);
  expect(r.json.data.recreated).toBe(true);
  expect(created.has("m1")).toBe(true);
});

test("a healthy wake does not recreate", async () => {
  const id = await add();
  await post(`/api/v1/computers/${id}/sleep`);
  const data = (await post(`/api/v1/computers/${id}/wake`)).json.data;
  expect(data).toEqual({ id, sleeping: false, ready: true, recreated: false });
});

test("a task wakes a sleeping target", async () => {
  // A schedule naming a sleeping machine should work, not fail.
  const id = await add();
  await post(`/api/v1/computers/${id}/sleep`);
  expect((await view(id)).sleeping).toBe(true);

  const r = await post("/api/v1/tasks", { json: { desktop: "m1", description: "after hours" } });
  expect(r.status).toBe(201);
  // startTask wakes before handing off to the runner; the runner itself is the
  // only part the test seam skips.
  const { lastStarted } = await import("../src/tasks");
  await lastStarted();
  expect((await view(id)).sleeping).toBe(false);
});
