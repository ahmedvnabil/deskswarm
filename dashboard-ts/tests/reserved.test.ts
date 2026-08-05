/**
 * A reserved machine is one you are driving by hand. The point of the flag is
 * that a fleet-wide dispatch must not grab its keyboard out from under you.
 */
import { beforeEach, expect, test } from "bun:test";
import { addMachine, get, patch, post, reset } from "./harness";

let ids: Record<string, number>;

beforeEach(async () => {
  reset();
  for (const n of ["w1", "w2", "mine"]) await addMachine(n);
  ids = Object.fromEntries(
    (await get("/api/v1/computers")).json.data.map((c: any) => [c.name, c.id]),
  );
  await patch(`/api/v1/computers/${ids.mine}`, { json: { reserved: "1" } });
});

async function targetsOf(body: Record<string, unknown>) {
  const r = await post("/api/v1/tasks", { json: { description: "x", ...body } });
  expect(r.status).toBe(201);
  const rows = new Map<number, string>(
    (await get("/api/v1/tasks")).json.data.map((t: any) => [t.id, t.desktop]),
  );
  return r.json.data.task_ids.map((i: number) => rows.get(i)).sort();
}

test("a fleet-wide dispatch skips a reserved machine", async () => {
  expect(await targetsOf({ desktop: "all" })).toEqual(["w1", "w2"]);
});

test("naming a reserved machine still works", async () => {
  // Explicitly targeting it is a deliberate choice, not an accident.
  expect(await targetsOf({ desktop: "mine" })).toEqual(["mine"]);
});

test("un-reserving puts it back in the fleet", async () => {
  await patch(`/api/v1/computers/${ids.mine}`, { json: { reserved: "0" } });
  expect(await targetsOf({ desktop: "all" })).toEqual(["mine", "w1", "w2"]);
});

test("all reserved is an error, not a silent no-op", async () => {
  for (const name of ["w1", "w2"]) {
    await patch(`/api/v1/computers/${ids[name]}`, { json: { reserved: "1" } });
  }
  const r = await post("/api/v1/tasks", { json: { desktop: "all", description: "x" } });
  expect(r.status).toBe(400);
  expect(r.json.error).toContain("every machine is reserved");
});

test("the flag is reported and toggles", async () => {
  const byName = Object.fromEntries(
    (await get("/api/v1/computers")).json.data.map((c: any) => [c.name, c]),
  );
  expect(byName.mine.reserved).toBe(true);
  expect(byName.w1.reserved).toBe(false);
});

test("reserving does not touch the name", async () => {
  await patch(`/api/v1/computers/${ids.mine}`, { json: { reserved: "1" } });
  const names = (await get("/api/v1/computers")).json.data.map((c: any) => c.name).sort();
  expect(names).toEqual(["mine", "w1", "w2"]);
});
