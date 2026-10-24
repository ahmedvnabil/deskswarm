// Real workerd/SQLite Durable Object; no cloud credentials or network provisioning.
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const options = {
  modules: true,
  script: readFileSync(
    new URL("../src/cloudflare/coordination-worker.js", import.meta.url),
    "utf8",
  ),
  compatibilityDate: "2026-07-30",
  bindings: { COMPUTE_SECRET: "offline-test-secret" },
  durableObjects: { SESSIONS: { className: "CloudSession", useSQLite: true } },
};
const mf = new Miniflare(options);
const call = (path, body, secret = "offline-test-secret") =>
  mf.dispatchFetch("https://prototype.test/sessions/demo/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
try {
  assert.equal((await call("state", undefined, "wrong")).status, 401);
  const attempts = await Promise.all([
    call("reserve", { owner: "run-1", seconds: 300 }),
    call("reserve", { owner: "run-2", seconds: 300 }),
  ]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
  const state = await (await call("state")).json();
  assert.equal(state.execution_connected, false);
  const owner = state.lease.owner,
    other = owner === "run-1" ? "run-2" : "run-1";
  assert.equal((await call("release", { owner: other })).status, 409);
  // A new request reaches the same named Durable Object and retained owner.
  assert.equal((await (await call("state")).json()).lease.owner, owner);
  assert.equal((await call("release", { owner })).status, 200);
  assert.equal((await (await call("state")).json()).lease, null);
  assert.equal(
    (await call("reserve", { owner: "run-3", seconds: 9999 })).status,
    400,
  );
  console.log(
    "PASS: real SQLite Durable Object, concurrent exclusive lease, persistent owner, protected release, no execution claim",
  );
} finally {
  await mf.dispose();
}
