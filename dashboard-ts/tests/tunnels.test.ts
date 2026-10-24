import { beforeEach, afterEach, expect, test } from "bun:test";
import { reset, get, post } from "./harness";
import { one, all, run } from "../src/db";
import { cfTransport, jobs } from "../src/cloudflare/control";
import { tunnelHost, CLOUDFLARED_IMAGE } from "../src/cloudflare/tunnel-host";
import { decryptSecret } from "../src/agents/store";
const originals = { fetch: cfTransport.fetch, ...tunnelHost };
const candidate = {
  id: "c".repeat(64),
  name: "deskswarm-dashboard",
  network: "private-desk",
  port: 7000,
};
const input = {
  account: "a".repeat(32),
  token: "fixture-account-token",
  worker: "deskswarm-edge",
  zone: "b".repeat(32),
  server_id: 0,
  backend: candidate.id,
  hostname: "desk-origin.example.com",
  deploy: false,
};
const uuid = "11111111-1111-1111-1111-111111111111";
let calls: { url: string; init?: RequestInit }[],
  created: number,
  records: any[],
  startFailed: boolean,
  started: any;
function success(value: any) {
  return Response.json({ success: true, result: value });
}
beforeEach(() => {
  reset();
  calls = [];
  created = 0;
  records = [];
  startFailed = false;
  started = null;
  tunnelHost.discover = async () => [candidate];
  tunnelHost.probe = async () => candidate;
  tunnelHost.start = async (_id, body) => {
    if (startFailed) throw Error("fixture private token: should never escape");
    started = body;
    return "connector-container";
  };
  tunnelHost.stop = async () => {};
  cfTransport.fetch = async (url, init) => {
    const value = String(url);
    calls.push({ url: value, init });
    if (value.endsWith("/_edge/health"))
      return Response.json({
        architecture: "worker-durable-object-linux",
        release: `job-${jobs()[0].id}`,
      });
    if (value.endsWith("/settings"))
      return Response.json({ success: false }, { status: 404 });
    if (value.endsWith("/deployments"))
      return success({
        deployments: [
          {
            versions: [
              {
                version_id: "22222222-2222-2222-2222-222222222222",
                percentage: 100,
              },
            ],
          },
        ],
      });
    if (value.includes("/workers/scripts/") && init?.method === "PUT")
      return success({ version_id: "22222222-2222-2222-2222-222222222222" });
    if (value === `https://${input.hostname}/health`)
      return Response.json({ status: "ok" });
    if (value.endsWith("/accounts?per_page=50"))
      return success([{ id: input.account, name: "Account" }]);
    if (value.includes("/zones?"))
      return success([{ id: input.zone, name: "example.com" }]);
    if (value.endsWith(`/zones/${input.zone}`))
      return success({
        id: input.zone,
        name: "example.com",
        status: "active",
        account: { id: input.account },
      });
    if (value.endsWith("/workers/subdomain"))
      return success({ subdomain: "fixture" });
    if (value.includes("/dns_records?")) return success(records);
    if (value.endsWith("/dns_records")) {
      records = [{ ...JSON.parse(String(init?.body)), id: "dns-id" }];
      return success(records[0]);
    }
    if (value.endsWith("/cfd_tunnel") && init?.method === "POST") {
      created++;
      return success({ id: uuid });
    }
    if (value.includes("/cfd_tunnel?name="))
      return success(
        created
          ? [
              {
                id: uuid,
                name: one("SELECT resource_name FROM cloudflare_tunnels")!
                  .resource_name,
              },
            ]
          : [],
      );
    if (value.includes("/cfd_tunnel?")) return success([]);
    if (value.endsWith("/token"))
      return success("fixture-connector-private-token");
    return success({});
  };
});
afterEach(() => {
  cfTransport.fetch = originals.fetch;
  tunnelHost.discover = originals.discover;
  tunnelHost.probe = originals.probe;
  tunnelHost.start = originals.start;
  tunnelHost.stop = originals.stop;
});
async function prepare(extra: any = {}) {
  return post("/api/v1/cloudflare/tunnel/test", {
    json: { ...input, ...extra },
  });
}
async function start(extra: any = {}) {
  const tested = await prepare(extra);
  expect(tested.status, tested.text).toBe(200);
  return post("/api/v1/cloudflare/tunnel", {
    json: { ...input, ...extra, test_token: tested.json.data.test_token },
  });
}
async function finish() {
  for (let i = 0; i < 100 && jobs()[0]?.status === "running"; i++)
    await new Promise((r) => setTimeout(r, 5));
  return jobs()[0];
}
test("discovers account, domains and Docker service without exposing credentials or making changes", async () => {
  expect(
    (
      await post("/api/v1/cloudflare/accounts", {
        json: { token: input.token },
      })
    ).json.data[0].id,
  ).toBe(input.account);
  expect(
    (await post("/api/v1/cloudflare/zones", { json: input })).json.data[0].name,
  ).toBe("example.com");
  expect(
    (await post("/api/v1/cloudflare/targets", { json: { server_id: 0 } })).json
      .data,
  ).toEqual([candidate]);
  expect((await prepare()).status).toBe(200);
  expect(created).toBe(0);
  expect(started).toBeNull();
  expect(CLOUDFLARED_IMAGE).toContain("@sha256:");
});
test("preflight refuses conflicting DNS, foreign zones, changed parameters and an unprepared backend", async () => {
  records = [{ type: "A", content: "203.0.113.1" }];
  expect((await prepare()).status).toBe(400);
  records = [];
  expect((await prepare({ hostname: "foreign.example.org" })).status).toBe(400);
  const tested = await prepare();
  expect(tested.status).toBe(200);
  expect(
    (
      await post("/api/v1/cloudflare/tunnel", {
        json: {
          ...input,
          hostname: "changed.example.com",
          test_token: tested.json.data.test_token,
        },
      })
    ).status,
  ).toBe(409);
  tunnelHost.probe = async () => {
    throw Error("unprepared");
  };
  expect((await prepare()).status).toBe(400);
  expect(created).toBe(0);
});
test("creates remotely managed tunnel, catch-all ingress and DNS, starts connector, verifies origin, then saves encrypted connection", async () => {
  expect((await start()).status).toBe(202);
  const job = await finish();
  expect(String(job.status), String(job.error)).toBe("succeeded");
  const row = one("SELECT * FROM cloudflare_tunnels")!,
    connection = one("SELECT * FROM cloudflare_config")!;
  expect(row.status).toBe("ready");
  expect(row.tunnel_id).toBe(uuid);
  expect(row.secret).not.toContain(input.token);
  expect(decryptSecret(connection.secret)).toBe(input.token);
  expect(connection.origin).toBe("https://" + input.hostname);
  const ingress = calls.find((c) => c.url.endsWith("/configurations"))!;
  expect(JSON.parse(String(ingress.init?.body)).config.ingress).toEqual([
    { hostname: input.hostname, service: "http://deskswarm-dashboard:7000" },
    { service: "http_status:404" },
  ]);
  expect(records[0].content).toBe(uuid + ".cfargotunnel.com");
  expect(records[0].proxied).toBe(true);
  expect(started.token).toBe("fixture-connector-private-token");
  const state = await get("/api/v1/cloudflare/status");
  expect(state.text).not.toContain(input.token);
  expect(state.text).not.toContain(started.token);
  expect(
    all("SELECT detail FROM audit").some((r) =>
      String(r.detail).includes(input.token),
    ),
  ).toBe(false);
});
test("partial failure preserves resource IDs and original origin; retry reuses resources rather than duplicating them", async () => {
  run(
    "INSERT INTO cloudflare_config VALUES(1,?,?,?,'','','old')",
    input.account,
    input.worker,
    "https://old.example.com",
  );
  startFailed = true;
  await start();
  expect((await finish()).status).toBe("failed");
  expect(one("SELECT origin FROM cloudflare_config")!.origin).toBe(
    "https://old.example.com",
  );
  expect(one("SELECT tunnel_id FROM cloudflare_tunnels")!.tunnel_id).toBe(uuid);
  expect((await get("/api/v1/cloudflare/status")).text).not.toContain(
    "should never escape",
  );
  startFailed = false;
  await start();
  expect((await finish()).status).toBe("succeeded");
  expect(created).toBe(1);
  expect(records).toHaveLength(1);
});
test("stopping a connector is reversible and does not delete DNS or Cloudflare namespace", async () => {
  await start();
  await finish();
  const row = one("SELECT * FROM cloudflare_tunnels")!;
  expect(
    (await post(`/api/v1/cloudflare/tunnels/${row.id}/stop`, { json: {} }))
      .status,
  ).toBe(200);
  expect(one("SELECT status FROM cloudflare_tunnels")!.status).toBe("stopped");
  expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
  expect(records).toHaveLength(1);
  await start();
  expect((await finish()).status).toBe("succeeded");
  expect(created).toBe(1);
});
test("tunnel actions require a session and cannot run over another deployment", async () => {
  expect(
    (
      await post("/api/v1/cloudflare/tunnel/test", {
        json: input,
        noCookie: true,
      })
    ).status,
  ).toBe(401);
  const tested = await prepare();
  run(
    "INSERT INTO cloudflare_jobs(kind,status,stage,created_at,updated_at) VALUES('deploy','running','pending','now','now')",
  );
  expect(
    (
      await post("/api/v1/cloudflare/tunnel", {
        json: { ...input, test_token: tested.json.data.test_token },
      })
    ).status,
  ).toBe(409);
  expect(created).toBe(0);
});

test("one operation can provision Tunnel then deploy Worker and Durable Objects after origin passes health", async () => {
  await start({ deploy: true });
  const job = await finish();
  expect(String(job.status), String(job.error)).toBe("succeeded");
  expect(created).toBe(1);
  expect(one("SELECT status FROM cloudflare_tunnels")!.status).toBe("ready");
  const upload = calls.find(
    (c) => c.url.includes("/workers/scripts/") && c.init?.method === "PUT",
  )!;
  const metadata = JSON.parse(
    await ((upload.init!.body as FormData).get("metadata") as Blob).text(),
  );
  expect(metadata.bindings.find((b: any) => b.name === "ORIGIN").text).toBe(
    "https://" + input.hostname,
  );
  expect(metadata.migrations.new_sqlite_classes).toEqual(["DeviceSession"]);
});

test("explicit readiness check records unreachable origins without deleting their setup", async () => {
  await start();
  await finish();
  const row = one("SELECT * FROM cloudflare_tunnels")!;
  expect(
    (await post(`/api/v1/cloudflare/tunnels/${row.id}/check`, { json: {} }))
      .json.data.healthy,
  ).toBe(true);
  cfTransport.fetch = async () => {
    throw Error("network unavailable");
  };
  expect(
    (await post(`/api/v1/cloudflare/tunnels/${row.id}/check`, { json: {} }))
      .json.data.healthy,
  ).toBe(false);
  expect(one("SELECT status FROM cloudflare_tunnels")!.status).toBe(
    "unreachable",
  );
  expect(created).toBe(1);
});

test("an exact partial setup can resume with its encrypted key after the browser drops the raw token", async () => {
  startFailed = true;
  await start();
  await finish();
  startFailed = false;
  await start({ token: "" });
  expect((await finish()).status).toBe("succeeded");
  expect(created).toBe(1);
});
