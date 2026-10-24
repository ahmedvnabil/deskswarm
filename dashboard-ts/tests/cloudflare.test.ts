import { beforeEach, afterEach, expect, test } from "bun:test";
import { reset, get, post, addMachine } from "./harness";
import { all, one, run } from "../src/db";
import { decryptSecret } from "../src/agents/store";
import {
  cfTransport,
  jobs,
  recoverCloudflare,
} from "../src/cloudflare/control";
const realFetch = cfTransport.fetch;
const input = {
  account: "a".repeat(32),
  worker: "deskswarm-test",
  origin: "https://linux.example.com",
  token: "test-only-secret-never-real",
};
const oldVersion = "11111111-1111-1111-1111-111111111111";
const newVersion = "22222222-2222-2222-2222-222222222222";
let requests: { path: string; init?: RequestInit }[];
let active: string, owned: boolean, uploaded: boolean;
function result(value: unknown, status = 200) {
  return Response.json(
    {
      success: status < 400,
      result: value,
      errors: status >= 400 ? [{ code: 10000, message: input.token }] : [],
    },
    { status },
  );
}
beforeEach(() => {
  reset();
  requests = [];
  active = newVersion;
  owned = true;
  uploaded = false;
  cfTransport.fetch = async (url, init) => {
    const path = String(url);
    requests.push({ path, init });
    if (path === input.origin + "/health")
      return Response.json({ status: "ok" });
    if (path.endsWith("/_edge/health"))
      return Response.json({
        architecture: "worker-durable-object-linux",
        release: `job-${jobs()[0].id}`,
      });
    if (path.endsWith("/subdomain"))
      return result({ subdomain: "test-account" });
    if (path.endsWith("/settings"))
      return uploaded
        ? result({
            bindings: owned
              ? [{ name: "DESKSWARM_APP", text: "deskswarm-edge-v1" }]
              : [],
          })
        : result(null, 404);
    if (path.endsWith("/versions"))
      return result({ items: [{ id: oldVersion }, { id: newVersion }] });
    if (path.endsWith("/deployments") && init?.method === "POST") {
      active = JSON.parse(String(init.body)).versions[0].version_id;
      return result({ id: "deployment" });
    }
    if (path.endsWith("/deployments"))
      return result({
        deployments: [{ versions: [{ version_id: active, percentage: 100 }] }],
      });
    if (init?.method === "PUT") {
      uploaded = true;
      return result({ version_id: newVersion });
    }
    return result({});
  };
});
afterEach(() => {
  cfTransport.fetch = realFetch;
});
async function connect() {
  const test = await post("/api/v1/cloudflare/test", { json: input });
  expect(test.status, test.text).toBe(200);
  return post("/api/v1/cloudflare/connection", {
    json: { ...input, test_token: test.json.data.test_token },
  });
}
async function finished() {
  for (let i = 0; i < 100 && jobs()[0]?.status === "running"; i++)
    await new Promise((r) => setTimeout(r, 5));
  return jobs()[0];
}
test("connection requires exact tested data, encrypts token, and never exposes it", async () => {
  const tested = await post("/api/v1/cloudflare/test", { json: input });
  expect(
    (
      await post("/api/v1/cloudflare/connection", {
        json: {
          ...input,
          worker: "changed-worker",
          test_token: tested.json.data.test_token,
        },
      })
    ).status,
  ).toBe(400);
  expect((await connect()).status).toBe(200);
  const row = one("SELECT * FROM cloudflare_config")!;
  expect(row.secret).not.toContain(input.token);
  expect(decryptSecret(row.secret)).toBe(input.token);
  const state = await get("/api/v1/cloudflare/status");
  expect(state.text).not.toContain(input.token);
  expect(state.text).not.toContain(row.edge_secret);
  expect(
    all("SELECT detail FROM audit").some((r) =>
      String(r.detail).includes(input.token),
    ),
  ).toBe(false);
});
test("refuses unsafe origins and invalid account identifiers before contacting provider", async () => {
  for (const change of [
    { origin: "http://127.0.0.1" },
    { origin: "https://example.com/path" },
    { origin: "https://user:password@example.com" },
    { worker: "../other" },
    { account: "bad" },
  ])
    expect(
      (await post("/api/v1/cloudflare/test", { json: { ...input, ...change } }))
        .status,
    ).toBe(400);
  expect(requests).toHaveLength(0);
});
test("deploy uploads executable module, SQLite DO migration and secret binding then confirms live version", async () => {
  await connect();
  expect((await post("/api/v1/cloudflare/deploy", { json: {} })).status).toBe(
    202,
  );
  const job = await finished();
  expect(String(job.status), String(job.error)).toBe("succeeded");
  expect(job.version).toBe(newVersion);
  const upload = requests.find((r) => r.init?.method === "PUT")!;
  const metadata = JSON.parse(
    await ((upload.init!.body as FormData).get("metadata") as Blob).text(),
  );
  expect(metadata.migrations.new_sqlite_classes).toEqual(["DeviceSession"]);
  expect(
    metadata.bindings.find((b: any) => b.name === "EDGE_SECRET").type,
  ).toBe("secret_text");
  expect(
    await ((upload.init!.body as FormData).get("worker.js") as Blob).text(),
  ).toContain("export class DeviceSession");
  expect((await get("/api/v1/computers")).text).not.toContain(input.token);
});
test("rollback creates 100% deployment of an account version without uploading code or changing DO schema", async () => {
  await connect();
  uploaded = true;
  await post("/api/v1/cloudflare/rollback", { json: { version: oldVersion } });
  expect((await finished()).status).toBe("succeeded");
  const rollback = requests.find(
    (r) => r.path.endsWith("/deployments") && r.init?.method === "POST",
  )!;
  expect(JSON.parse(String(rollback.init?.body))).toEqual({
    strategy: "percentage",
    versions: [{ version_id: oldVersion, percentage: 100 }],
  });
  expect(requests.some((r) => r.init?.method === "PUT")).toBe(false);
});
test("refuses to overwrite another application and redacts provider failures", async () => {
  await connect();
  uploaded = true;
  owned = false;
  await post("/api/v1/cloudflare/deploy", { json: {} });
  expect((await finished()).status).toBe("failed");
  expect(requests.some((r) => r.init?.method === "PUT")).toBe(false);
  cfTransport.fetch = async () => result(null, 403);
  await post("/api/v1/cloudflare/deploy", { json: {} });
  const failed = await finished();
  expect(failed.status).toBe("failed");
  expect(failed.error).not.toContain(input.token);
});
test("only one deployment runs; restart retains interrupted record without replay", async () => {
  await connect();
  run(
    "INSERT INTO cloudflare_jobs(kind,status,stage,created_at,updated_at) VALUES('deploy','running','pending','now','now')",
  );
  expect((await post("/api/v1/cloudflare/deploy", { json: {} })).status).toBe(
    409,
  );
  recoverCloudflare();
  expect(jobs()[0].status).toBe("interrupted");
});
test("saved connection routes local desktop through authenticated same-origin screen assets", async () => {
  await connect();
  const created = await addMachine("Edge desktop");
  const comp = created.json.data;
  const fleet = await get(`/api/v1/computers`);
  const view = {
    json: { data: fleet.json.data.find((c: any) => c.id === comp.id) },
  };
  expect(view.json.data.novnc_url).toContain(
    `/remote-screen/${comp.id}/vnc.html`,
  );
  const page = await get(`/remote-screen/${comp.id}/vnc.html`);
  expect(page.status).toBe(200);
  expect(page.text).toContain("noVNC");
});

test("requires login and rejects cross-site cloud deployment mutations", async () => {
  expect(
    (await get("/api/v1/cloudflare/status", { noCookie: true })).status,
  ).toBe(401);
  expect(
    (await post("/api/v1/cloudflare/test", { json: input, noCookie: true }))
      .status,
  ).toBe(401);
  expect(
    (
      await post("/api/v1/cloudflare/deploy", {
        json: {},
        headers: { origin: "https://attacker.example" },
      })
    ).status,
  ).toBe(403);
  expect(requests).toHaveLength(0);
});

test('edge local control shares grant screen access without granting fleet access', async () => {
  await connect();
  const comp = (await addMachine('Shared edge desktop')).json.data;
  const share = (await post(`/api/v1/computers/${comp.id}/shares`, {json:{label:'guest',mode:'control',hours:1}})).json.data;
  const page = await get(`/s/${share.token}`, {noCookie:true});
  const cookie = page.headers.get('set-cookie')!.split(';')[0];
  expect(cookie).toContain(`deskswarm_screen_${comp.id}=`);
  expect((await get(`/remote-screen/${comp.id}/vnc.html`, {noCookie:true,headers:{cookie}})).status).toBe(200);
  expect((await get('/api/v1/cloudflare/status', {noCookie:true,headers:{cookie}})).status).toBe(401);
});
