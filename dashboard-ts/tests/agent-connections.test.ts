import { afterEach, beforeEach, expect, test } from "bun:test";
import { reset, post, get } from "./harness";
import { run } from "../src/db";
let gateway: ReturnType<typeof Bun.serve> | undefined;
beforeEach(reset);
afterEach(() => gateway?.stop(true));
async function model(managed_cli = "codex") {
  const added = await post("/api/v1/agents/models", {
    json: {
      name: "Server Codex",
      model: "default",
      base_url: `http://127.0.0.1:${gateway!.port}/v1`,
      protocol: "chat",
      api_key: "private-gateway-key",
      managed_cli,
    },
  });
  expect(added.status).toBe(201);
  return added.json.data.at(-1);
}
test("connection routes forward encrypted credentials and preserve useful status", async () => {
  let seen: any;
  gateway = Bun.serve({
    port: 0,
    fetch: async (req) => {
      seen = {
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization"),
        body: req.method === "POST" ? await req.json() : null,
      };
      return Response.json({
        provider: "codex",
        auth: { state: "signed_in" },
        test: { state: "connected" },
      });
    },
  });
  const m = await model();
  const result = await get(`/api/v1/agents/models/${m.id}/status`);
  expect(result.status).toBe(200);
  expect(result.json.data.test.state).toBe("connected");
  expect(seen.auth).toBe("Bearer private-gateway-key");
  expect(seen.path).toBe("/management/status");
  expect(result.text).not.toContain("private-gateway-key");
  await post(`/api/v1/agents/models/${m.id}/test`, {
    json: { model: "attacker-model" },
  });
  expect(seen.body.model).toBe("default");
  run(
    "INSERT INTO agent_runs(computer_id,model_id,task,status,max_steps,max_seconds,created_at,updated_at,actor) VALUES(1,?,'test','running',1,30,'','','test')",
    m.id,
  );
  expect(
    (await post(`/api/v1/agents/models/${m.id}/login`, { json: {} })).status,
  ).toBe(409);
});
test("regular API endpoints cannot receive CLI login requests and gateway failures explain repair", async () => {
  gateway = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({ error: "secret-debug-output" }, { status: 401 }),
  });
  const regular = await model("");
  expect(
    (await post(`/api/v1/agents/models/${regular.id}/login`, { json: {} }))
      .status,
  ).toBe(400);
  const m = await model();
  const r = await get(`/api/v1/agents/models/${m.id}/status`);
  expect(r.status).toBe(424);
  expect(r.text).toContain("مفتاح الاتصال");
  expect(r.text).not.toContain("secret-debug-output");
});
