import { beforeEach, expect, test } from "bun:test";
import { addMachine, del, get, patch, post, reset } from "./harness";
import { run } from "../src/db";
import { nowIso } from "../src/settings";
import { schedulerTick } from "../src/scheduler";
import { dispatched } from "./harness";
import { lastStarted } from "../src/tasks";

beforeEach(reset);

test("an interval schedule round-trips", async () => {
  await addMachine("m1");
  const r = await post("/api/v1/schedules", {
    json: { desktop: "m1", description: "ping", kind: "interval", every_minutes: 15 },
  });
  expect(r.status).toBe(201);
  expect(r.json.data.every_minutes).toBe(15);
  expect(r.json.data.enabled).toBe(1);

  const sid = r.json.data.id;
  expect((await patch(`/api/v1/schedules/${sid}`, { json: { enabled: "0" } })).status).toBe(200);
  expect((await get("/api/v1/schedules")).json.data[0].enabled).toBe(0);
  expect((await del(`/api/v1/schedules/${sid}`)).status).toBe(200);
  expect((await get("/api/v1/schedules")).json.data).toEqual([]);
});

test("a bad time is rejected", async () => {
  const r = await post("/api/v1/schedules", {
    json: { desktop: "all", description: "x", kind: "daily", at_time: "25:99" },
  });
  expect(r.status).toBe(400);
});

test("a daily next run is in the future", async () => {
  const r = await post("/api/v1/schedules", {
    json: { desktop: "all", description: "x", kind: "daily", at_time: "00:01" },
  });
  expect(new Date(r.json.data.next_run_at).getTime()).toBeGreaterThan(Date.now());
});

test("a due schedule fires once even with racing ticks", async () => {
  // Claiming is a conditional UPDATE on next_run_at, so only one tick may
  // dispatch a given schedule.
  await addMachine("m1");
  await post("/api/v1/schedules", {
    json: { desktop: "m1", description: "repeat me", kind: "interval", every_minutes: 1 },
  });
  run("UPDATE schedules SET next_run_at = ?", nowIso(new Date(Date.now() - 5 * 60_000)));

  schedulerTick();
  schedulerTick(); // a second caller arriving right behind the first

  await lastStarted(); // the wake runs before the worker seam
  expect(dispatched.length).toBe(1);
  const rows = (await get("/api/v1/tasks")).json.data;
  expect(rows.map((t: any) => [t.desktop, t.description])).toEqual([["m1", "repeat me"]]);
  expect((await get("/api/v1/schedules")).json.data[0].run_count).toBe(1);
});
