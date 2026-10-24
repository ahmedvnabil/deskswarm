import { beforeEach, afterEach, expect, test } from "bun:test";
import { reset, get, post, del } from "./harness";
import { one, run } from "../src/db";
import { decryptSecret } from "../src/agents/store";
import { netbirdTransport } from "../src/connections/netbird";
const original = netbirdTransport.fetch;
const credentials = {
  base_url: "https://api.netbird.io",
  token: "netbird-fixture-private-pat",
};
let peers: any[], captured: any;
beforeEach(() => {
  reset();
  peers = [
    {
      id: "linux-online",
      name: "Linux lab",
      ip: "100.64.1.2",
      connected: true,
      os: "Linux",
      last_seen: "2026-10-24T06:00:00Z",
    },
    {
      id: "linux-offline",
      name: "Offline lab",
      ip: "100.64.1.3",
      connected: false,
      os: "Linux",
    },
    {
      id: "mac",
      name: "Work laptop",
      ip: "100.64.1.4",
      connected: true,
      os: "Darwin",
    },
  ];
  captured = null;
  netbirdTransport.fetch = async (url, init) => {
    captured = { url, init };
    return Response.json(peers);
  };
});
afterEach(() => {
  netbirdTransport.fetch = original;
});
async function connect() {
  const tested = await post("/api/v1/netbird/test", { json: credentials });
  expect(tested.status).toBe(200);
  return post("/api/v1/netbird/connection", {
    json: { ...credentials, test_token: tested.json.data.test_token },
  });
}
test("tests and encrypts PAT, uses Token authentication, and preserves offline unconfigured devices", async () => {
  expect((await connect()).status).toBe(200);
  expect(captured.url).toBe("https://api.netbird.io/api/peers");
  expect(captured.init.headers.Authorization).toBe(
    "Token " + credentials.token,
  );
  const row = one("SELECT * FROM netbird_connection")!;
  expect(row.secret).not.toContain(credentials.token);
  expect(decryptSecret(row.secret)).toBe(credentials.token);
  const result = await get("/api/v1/netbird/peers");
  expect(result.text).not.toContain(credentials.token);
  expect(result.json.data.peers).toHaveLength(3);
  const offline = result.json.data.peers.find(
    (p: any) => p.id === "linux-offline",
  );
  expect(offline.connected).toBe(false);
  expect(offline.readiness).toBe("unconfigured");
  expect(offline.connectable).toBe(true);
  expect(
    result.json.data.peers.find((p: any) => p.id === "mac").connectable,
  ).toBe(false);
});
test("sync does not turn stale inventory into fabricated offline status or discard it on failure", async () => {
  await connect();
  netbirdTransport.fetch = async () =>
    Response.json({ secret: credentials.token }, { status: 403 });
  expect((await post("/api/v1/netbird/sync", { json: {} })).status).toBe(400);
  const stale = (await get("/api/v1/netbird/peers")).json.data;
  expect(stale.peers).toHaveLength(3);
  expect(stale.peers.find((p: any) => p.id === "linux-online").connected).toBe(
    true,
  );
  expect(stale.connection.error).toContain("آخر بيانات");
  netbirdTransport.fetch = async () => Response.json(peers.slice(0, 1));
  expect((await post("/api/v1/netbird/sync", { json: {} })).status).toBe(200);
  expect((await get("/api/v1/netbird/peers")).json.data.peers).toHaveLength(1);
});
test("cannot save changed or replayed tickets, send saved PAT to a different host, or follow redirect", async () => {
  const tested = await post("/api/v1/netbird/test", { json: credentials });
  expect(
    (
      await post("/api/v1/netbird/connection", {
        json: {
          ...credentials,
          base_url: "https://other.example",
          test_token: tested.json.data.test_token,
        },
      })
    ).status,
  ).toBe(400);
  await connect();
  captured = null;
  expect(
    (
      await post("/api/v1/netbird/test", {
        json: { base_url: "https://other.example" },
      })
    ).status,
  ).toBe(400);
  expect(captured).toBeNull();
  expect(
    (
      await post("/api/v1/netbird/test", {
        json: { ...credentials, base_url: "http://example.com" },
      })
    ).status,
  ).toBe(400);
  await post("/api/v1/netbird/test", {
    json: { base_url: credentials.base_url },
  });
  expect(captured.init.redirect).toBe("error");
});
test("maps existing SSH hosts separately from network online state and saves reusable non-secret defaults", async () => {
  await connect();
  run(
    "INSERT INTO servers(name,host,port,username,fingerprint,secret,status,checked_at,info) VALUES('Lab','100.64.1.2',22,'ubuntu','','','unreachable','now','{}')",
  );
  const online = (await get("/api/v1/netbird/peers")).json.data.peers.find(
    (p: any) => p.id === "linux-online",
  );
  expect(online.connected).toBe(true);
  expect(online.server_id).toBeNumber();
  expect(online.server_status).toBe("unreachable");
  expect(
    (
      await post("/api/v1/connections/preferences", {
        json: { ssh_user: "deployer", ssh_port: 2222 },
      })
    ).status,
  ).toBe(200);
  expect(
    (await get("/api/v1/connections/status")).json.data.preferences,
  ).toEqual({ ssh_user: "deployer", ssh_port: 2222 });
  expect(
    (
      await post("/api/v1/connections/preferences", {
        json: { ssh_user: "root;bad", ssh_port: 0 },
      })
    ).status,
  ).toBe(400);
});
test("all network inventory and preference routes require authentication and reject cross-site writes", async () => {
  expect((await get("/api/v1/netbird/peers", { noCookie: true })).status).toBe(
    401,
  );
  expect(
    (await get("/api/v1/connections/status", { noCookie: true })).status,
  ).toBe(401);
  expect(
    (
      await post("/api/v1/netbird/test", {
        json: credentials,
        headers: { origin: "https://attacker.example" },
      })
    ).status,
  ).toBe(403);
  expect(captured).toBeNull();
});
test("actual HTTP peer service receives the provider authorization protocol and returns UTF-8 names", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      expect(request.headers.get("authorization")).toBe(
        "Token " + credentials.token,
      );
      return Response.json([
        {
          id: "arabic",
          name: "سيرفر اختبار",
          ip: "100.64.2.1",
          connected: false,
          os: "Linux",
        },
      ]);
    },
  });
  netbirdTransport.fetch = (url, init) =>
    fetch(`http://127.0.0.1:${server.port}${new URL(url).pathname}`, init);
  try {
    await connect();
    expect((await get("/api/v1/netbird/peers")).json.data.peers[0].name).toBe(
      "سيرفر اختبار",
    );
  } finally {
    server.stop(true);
  }
});
