import { beforeEach, describe, expect, test } from "bun:test";
import { addMachine, created, del, get, patch, post, reset } from "./harness";

beforeEach(reset);

test("create, rename, delete", async () => {
  const r = await addMachine("alpha");
  expect(r.status).toBe(201);
  const cid = r.json.data.id;

  expect((await patch(`/api/v1/computers/${cid}`, { json: { name: "alpha-renamed" } })).status).toBe(200);
  expect((await get("/api/v1/computers")).json.data.map((c: any) => c.name)).toEqual(["alpha-renamed"]);

  expect((await del(`/api/v1/computers/${cid}`)).status).toBe(200);
  expect((await get("/api/v1/computers")).json.data).toEqual([]);
});

test("a duplicate name is rejected", async () => {
  await addMachine("dup");
  expect((await addMachine("dup")).status).toBe(409);
});

test("delete survives missing containers", async () => {
  const cid = (await addMachine("ghost")).json.data.id;
  created.clear();
  expect((await del(`/api/v1/computers/${cid}`)).status).toBe(200);
});

test("ports do not collide", async () => {
  for (const n of ["a", "b", "c"]) await addMachine(n);
  const ports = (await get("/api/v1/computers")).json.data.map((c: any) => c.novnc_port);
  expect(new Set(ports).size).toBe(ports.length);
});

describe("batch names", () => {
  test("a range expands", async () => {
    const data = (await addMachine("agent-{1..3}")).json.data;
    expect(data.created.map((c: any) => c.name)).toEqual(["agent-1", "agent-2", "agent-3"]);
    expect(data.errors).toEqual([]);
  });

  test("zero padding is preserved", async () => {
    const data = (await addMachine("node-{01..03}")).json.data;
    expect(data.created.map((c: any) => c.name)).toEqual(["node-01", "node-02", "node-03"]);
  });

  test("clashes do not block the rest", async () => {
    await addMachine("x-2");
    const data = (await addMachine("x-{1..3}")).json.data;
    expect(data.created.map((c: any) => c.name)).toEqual(["x-1", "x-3"]);
    expect(data.errors.map((e: any) => e.name)).toEqual(["x-2"]);
  });

  test("an oversized range is refused", async () => {
    const r = await addMachine("big-{1..999}");
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("more than");
  });

  test("a single name returns the object, not a batch", async () => {
    expect((await addMachine("solo")).json.data.name).toBe("solo");
  });
});

test("a snapshot name must be free", async () => {
  const cid = (await addMachine("src")).json.data.id;
  expect((await post(`/api/v1/computers/${cid}/snapshot`, { json: { name: "snap" } })).status).toBe(201);
  expect((await post(`/api/v1/computers/${cid}/snapshot`, { json: { name: "snap" } })).status).toBe(409);
});

test("creating from an unknown snapshot fails", async () => {
  const r = await addMachine("box", { snapshot: "nope" });
  expect(r.status).toBe(400);
  expect(r.json.error).toContain("unknown snapshot");
});
