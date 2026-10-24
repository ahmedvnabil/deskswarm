import { afterEach, beforeEach, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import * as tar from "tar-stream";
import {
  reset,
  addMachine,
  post,
  get,
  patch,
  issueKey,
  callTool,
  world,
  execLog,
} from "./harness";
import { one, run } from "../src/db";
import {
  decryptSecret,
  modelById,
  recoverInterrupted,
  runById,
} from "../src/agents/store";
const { idleTick } = await import("../src/housekeeping");
import { requestModel } from "../src/agents/model";

let server: ReturnType<typeof Bun.serve> | undefined;
let ids: number[] = [];
const wait = async (predicate: () => boolean) => {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("worker did not settle");
};
beforeEach(() => {
  reset();
  ids = [];
});
afterEach(async () => {
  for (const id of ids) {
    if (runById(id)?.lease) await post(`/api/v1/agents/runs/${id}/stop`);
  }
  await wait(() => ids.every((id) => !runById(id)?.lease));
  server?.stop(true);
  server = undefined;
});
async function fixture(handler: (body: any, req: Request) => any) {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      return Response.json(await handler(await req.json(), req));
    },
  });
  const added = await addMachine("Agent desktop");
  expect(added.status, added.text).toBe(201);
  const comp = added.json.data;
  const response = await post("/api/v1/agents/models", {
    json: {
      name: "Test model",
      model: "test",
      base_url: `http://127.0.0.1:${server.port}/v1`,
      protocol: "chat",
      vision: false,
      api_key: "test-private-secret",
    },
  });
  expect(response.status).toBe(201);
  return { comp, model: response.json.data[0] };
}
async function start(comp: any, model: any, extra = {}) {
  const r = await post("/api/v1/agents/runs", {
    json: {
      computer_id: comp.id,
      model_id: model.id,
      task: "Write and verify Arabic results",
      ...extra,
    },
  });
  if (r.status === 202) ids.push(r.json.data.id);
  return r;
}
const answer = (content: string) => ({
  choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
});
const tool = (name: string, args: any) => ({
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-" + Math.random(),
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
    },
  ],
});

test("model credentials are encrypted, never returned, and preserved on edit", async () => {
  const { model } = await fixture(() => answer("done"));
  expect(JSON.stringify(model)).not.toContain("test-private-secret");
  const saved = modelById(model.id)!;
  expect(saved.secret).not.toContain("test-private-secret");
  expect(decryptSecret(saved.secret)).toBe("test-private-secret");
  await post("/api/v1/agents/models", {
    json: { ...model, name: "Renamed", api_key: "" },
  });
  expect(decryptSecret(modelById(model.id)!.secret)).toBe(
    "test-private-secret",
  );
  expect((await get("/api/v1/agents/models", { noCookie: true })).status).toBe(
    401,
  );
});

test("one lease blocks duplicate runs, machine changes and existing MCP clients until takeover", async () => {
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { comp, model } = await fixture(async () => {
    entered = true;
    await gate;
    return answer("done");
  });
  const token = (await issueKey(comp.id)).json.data.token;
  const first = await start(comp, model);
  expect(first.status).toBe(202);
  await wait(() => entered);
  expect((await start(comp, model)).status).toBe(409);
  expect(
    (await patch(`/api/v1/computers/${comp.id}`, { json: { name: "Changed" } }))
      .status,
  ).toBe(409);
  const outside = await callTool(comp.slug, token, "click", { x: 10, y: 10 });
  expect(outside.result?.isError || outside.error).toBeTruthy();
  expect(
    (await get(`/api/v1/agents/runs/${first.json.data.id}`)).json.data
      .viewer_url,
  ).toContain("view_only=true");
  expect(
    (await get(`/api/v1/agents/runs/${first.json.data.id}/result`)).status,
  ).toBe(409);
  await post(`/api/v1/agents/runs/${first.json.data.id}/takeover`);
  release();
  await wait(() => !runById(first.json.data.id)?.lease);
  expect(runById(first.json.data.id)?.status).toBe("taken_over");
  expect(
    one<any>("SELECT reserved FROM computers WHERE id=?", comp.id)?.reserved,
  ).toBe(1);
  expect((await start(comp, model)).status).toBe(409);
  await patch(`/api/v1/computers/${comp.id}`, { json: { reserved: false } });
});

test("executes tools, insists on verification, and downloads real UTF-8 bytes", async () => {
  let turn = 0;
  const { comp, model } = await fixture((body, req) => {
    expect(req.headers.get("authorization")).toBe("Bearer test-private-secret");
    turn++;
    if (turn === 1)
      return tool("write_file", {
        path: "result.txt",
        content: "مرحبًا من الوكيل",
      });
    if (turn === 2) return answer("premature completion");
    if (turn === 3) {
      expect(body.messages.at(-1).content).toContain("Verify");
      return tool("save_result", { path: "result.txt" });
    }
    return answer("تم حفظ النتيجة والتحقق منها");
  });
  const result = await start(comp, model);
  const id = result.json.data.id;
  await wait(() => !runById(id)?.lease);
  expect(runById(id)?.status).toBe("completed");
  expect(turn).toBe(4);
  const download = await get(`/api/v1/agents/runs/${id}/result`);
  expect(download.status).toBe(200);
  const files = new Map<string, string>();
  const extract = tar.extract();
  const done = new Promise<void>((resolve, reject) => {
    extract.on("entry", (h, s, next) => {
      let b = "";
      s.on("data", (c) => (b += c.toString()));
      s.on("end", () => {
        files.set(h.name, b);
        next();
      });
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
  });
  extract.end(gunzipSync(download.bytes));
  await done;
  expect(
    [...files.entries()].find(([name]) => name.endsWith("-result.txt"))?.[1],
  ).toBe("مرحبًا من الوكيل");
  expect(files.get("report.md")).toContain("completed");
  expect(files.get("activity.json")).toContain("save_result");
});

test("step limit fails without replay and restart retains ownership for explicit acknowledgement", async () => {
  const { comp, model } = await fixture(() => tool("screen_size", {}));
  const result = await start(comp, model, { max_steps: 1 });
  const id = result.json.data.id;
  await wait(() => !runById(id)?.lease);
  expect(runById(id)?.error).toContain("Step limit");
  run("UPDATE agent_runs SET lease=1,status='running' WHERE id=?", id);
  recoverInterrupted();
  expect(runById(id)?.status).toBe("interrupted");
  expect((await start(comp, model)).status).toBe(409);
  expect((await post(`/api/v1/agents/runs/${id}/takeover`)).status).toBe(409);
  expect(runById(id)?.status).toBe("interrupted");
  run("UPDATE agent_runs SET drain_until=0 WHERE id=?", id);
  await post(`/api/v1/agents/runs/${id}/takeover`);
  expect(runById(id)?.lease).toBe(0);
});

test("Responses carries tool definitions and stateless reasoning", async () => {
  let body: any;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      body = await req.json();
      return Response.json({
        status: "completed",
        output: [
          { type: "reasoning", encrypted_content: "opaque" },
          {
            type: "function_call",
            call_id: "c1",
            name: "screenshot",
            arguments: "{}",
          },
        ],
      });
    },
  });
  const model: any = {
    model: "test",
    base_url: `http://127.0.0.1:${server.port}/v1`,
    protocol: "responses",
  };
  const response = await requestModel(
    model,
    "",
    [],
    [
      {
        name: "screenshot",
        description: "screen",
        inputSchema: { type: "object" },
      },
    ],
    new AbortController().signal,
  );
  expect(response.calls[0].id).toBe("c1");
  expect(response.assistant[0].encrypted_content).toBe("opaque");
  expect(body.store).toBe(false);
  expect(body.tools[0].name).toBe("screenshot");
});

test("takeover keeps its lease until both in-flight shell and Driver cleanup drain", async () => {
  let releaseShell!: () => void, releaseDriver!: () => void;
  world.execGate = new Promise<void>((resolve) => (releaseShell = resolve));
  world.endSessionGate = new Promise<void>(
    (resolve) => (releaseDriver = resolve),
  );
  const { comp, model } = await fixture(() =>
    tool("shell", { command: "sleep 30" }),
  );
  const id = (await start(comp, model)).json.data.id;
  await wait(() => execLog.some((c) => c.includes("setsid bash")));
  process.env.DESKSWARM_IDLE_SUSPEND_MINUTES = "1";
  run(
    "UPDATE computers SET last_active_at='2000-01-01T00:00:00+00:00' WHERE id=?",
    comp.id,
  );
  await idleTick();
  const stopping = post(`/api/v1/agents/runs/${id}/takeover`);
  await wait(() => runById(id)?.status === "stopping");
  releaseShell();
  await Bun.sleep(30);
  expect(runById(id)?.lease).toBe(1);
  expect((await start(comp, model)).status).toBe(409);
  releaseDriver();
  await stopping;
  await wait(() => !runById(id)?.lease);
  expect(runById(id)?.status).toBe("taken_over");
});

test("an existing external MCP action must finish before a managed agent claims the desktop", async () => {
  const { comp, model } = await fixture(() => answer("Done"));
  const token = (await issueKey(comp.id)).json.data.token;
  let release!: () => void;
  world.execGate = new Promise<void>((resolve) => (release = resolve));
  const outside = callTool(comp.slug, token, "shell", {
    command: "external-inflight",
  });
  await wait(() => execLog.includes("external-inflight"));
  expect((await start(comp, model)).status).toBe(409);
  release();
  await outside;
  const job = await start(comp, model);
  expect(job.status).toBe(202);
  await wait(() => !runById(job.json.data.id)?.lease);
});
