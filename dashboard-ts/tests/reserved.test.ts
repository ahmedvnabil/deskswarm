/**
 * A reserved machine is one you are driving by hand.
 *
 * The flag used to mean "fleet-wide dispatch skips it". There is no dispatch
 * any more, so it means the thing that would take the keyboard out from under
 * you now: no key can be issued for it, and so no outside client can reach it.
 */
import { beforeEach, expect, test } from "bun:test";
import { addMachine, get, issueKey, patch, reset } from "./harness";

let ids: Record<string, number>;

beforeEach(async () => {
  reset();
  for (const n of ["w1", "w2", "mine"]) await addMachine(n);
  ids = Object.fromEntries(
    (await get("/api/v1/computers")).json.data.map((c: any) => [c.name, c.id]),
  );
  await patch(`/api/v1/computers/${ids.mine}`, { json: { reserved: "1" } });
});

test("a reserved machine refuses to hand out a key", async () => {
  const r = await issueKey(ids.mine);
  expect(r.status).toBe(409);
  expect(r.json.error).toContain("reserved");
});

test("an unreserved machine hands one out", async () => {
  expect((await issueKey(ids.w1)).status).toBe(201);
});

test("un-reserving puts it back in the fleet", async () => {
  await patch(`/api/v1/computers/${ids.mine}`, { json: { reserved: "0" } });
  expect((await issueKey(ids.mine)).status).toBe(201);
});

/**
 * Reserving does not revoke what is already out.
 *
 * Deliberate, and the opposite would be worse: a flag meant to keep a machine
 * to yourself for an afternoon should not silently break a client someone
 * wired up last week. Revoking the key is the way to do that, and it is one
 * click away.
 */
test("reserving leaves an existing key working", async () => {
  const key = (await issueKey(ids.w1)).json.data;
  await patch(`/api/v1/computers/${ids.w1}`, { json: { reserved: "1" } });
  const listed = (await get("/api/v1/keys")).json.data.find((k: any) => k.id === key.id);
  expect(listed.status).toBe("live");
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
