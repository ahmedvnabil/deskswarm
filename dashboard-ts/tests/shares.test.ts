/**
 * Sharing one machine without sharing the fleet.
 *
 * The interesting cases are the negative ones: a share must reach exactly one
 * machine, stop working the moment it is revoked or expires, and never become
 * a way into the dashboard.
 */
import { beforeEach, expect, test } from "bun:test";
import { addMachine, del, get, post, reset } from "./harness";
import { run } from "../src/db";
import { nowIso } from "../src/settings";

beforeEach(reset);

const add = async (name = "m1") => (await addMachine(name)).json.data.id;

async function makeShare(id: number, extra: Record<string, unknown> = {}) {
  const r = await post(`/api/v1/computers/${id}/shares`, {
    json: { label: "sara", mode: "watch", hours: 24, ...extra },
  });
  expect(r.status).toBe(201);
  return r.json.data;
}

test("a share opens its machine and says which", async () => {
  const id = await add("reception");
  const share = await makeShare(id);
  const r = await get(`/s/${share.token}`);
  expect(r.status).toBe(200);
  expect(r.text).toContain("reception");
});

test("a watch share never exposes the screen password", async () => {
  // That is the whole difference between watch and control.
  const id = await add();
  const share = await makeShare(id, { mode: "watch" });
  const password = (await get("/api/v1/computers")).json.data[0].vnc_password;
  const page = (await get(`/s/${share.token}`)).text;
  expect(page).not.toContain(password);
  expect(page).not.toContain("/vnc.html");
});

test("a control share does embed the session", async () => {
  const id = await add();
  const share = await makeShare(id, { mode: "control" });
  expect((await get(`/s/${share.token}`)).text).toContain("/vnc.html");
});

test("revoking kills the link immediately", async () => {
  const id = await add();
  const share = await makeShare(id);
  expect((await get(`/s/${share.token}`)).status).toBe(200);

  expect((await del(`/api/v1/shares/${share.id}`)).status).toBe(200);
  expect((await get(`/s/${share.token}`)).status).toBe(404);
  expect((await get(`/s/${share.token}/screen.png`)).status).toBe(404);
});

test("revoking a control share admits what it cannot do", async () => {
  const id = await add();
  const share = await makeShare(id, { mode: "control" });
  const note = (await del(`/api/v1/shares/${share.id}`)).json.data.note;
  expect(note).toContain("rotate");
});

test("an expired share stops working", async () => {
  const id = await add();
  const share = await makeShare(id);
  run(
    "UPDATE shares SET expires_at = ? WHERE id = ?",
    nowIso(new Date(Date.now() - 60_000)),
    share.id,
  );
  expect((await get(`/s/${share.token}`)).status).toBe(404);
});

test("a wrong token looks exactly like a revoked one", async () => {
  // Telling a stranger which it is tells them whether to keep guessing.
  const id = await add();
  const share = await makeShare(id);
  await del(`/api/v1/shares/${share.id}`);

  const revoked = await get(`/s/${share.token}`);
  const never = await get("/s/" + "z".repeat(43));
  expect(revoked.status).toBe(404);
  expect(never.status).toBe(404);
  expect(revoked.text).toBe(never.text);
});

test("rotating the password revokes control shares and changes the password", async () => {
  const id = await add();
  const before = (await get("/api/v1/computers")).json.data[0].vnc_password;
  const watch = await makeShare(id, { mode: "watch", label: "watcher" });
  const control = await makeShare(id, { mode: "control", label: "driver" });

  expect((await post(`/api/v1/computers/${id}/rotate-password`)).status).toBe(200);
  const after = (await get("/api/v1/computers")).json.data[0].vnc_password;
  expect(after).not.toBe(before);

  const states = Object.fromEntries(
    (await get("/api/v1/shares")).json.data.map((s: any) => [s.id, s.status]),
  );
  expect(states[control.id]).toBe("revoked");
  expect(states[watch.id]).toBe("live"); // a watch share was never at risk
});

test("a share cannot reach another machine or the fleet", async () => {
  await add("m1");
  const other = await add("m2");
  const share = await makeShare(other);
  // The share namespace is exactly two routes; nothing else answers under it.
  expect((await post(`/s/${share.token}/screen.png`)).status).toBe(404);
});

test("share use is counted and attributed", async () => {
  const id = await add("shared-box");
  const share = await makeShare(id, { label: "sara" });
  await get(`/s/${share.token}`);
  await get(`/s/${share.token}`);

  const row = (await get("/api/v1/shares")).json.data.find((s: any) => s.id === share.id);
  expect(row.uses).toBe(2);
  expect(row.last_used_at).toBeTruthy();

  const guest = (await get("/api/v1/audit")).json.data.filter(
    (e: any) => e.actor === "share:sara",
  );
  expect(guest.length).toBeGreaterThan(0);
  expect(guest[0].target).toBe("shared-box");
});

test("a bad mode and a silly expiry are refused", async () => {
  const id = await add();
  expect((await post(`/api/v1/computers/${id}/shares`, { json: { mode: "root" } })).status).toBe(400);
  expect((await post(`/api/v1/computers/${id}/shares`, { json: { hours: 0 } })).status).toBe(400);
  expect((await post(`/api/v1/computers/${id}/shares`, { json: { hours: 99999 } })).status).toBe(400);
});

test("tokens are not guessable", async () => {
  const id = await add();
  const tokens = new Set<string>();
  for (let i = 0; i < 5; i++) tokens.add((await makeShare(id)).token);
  expect(tokens.size).toBe(5);
  expect([...tokens].every((t) => t.length >= 32)).toBe(true);
});
