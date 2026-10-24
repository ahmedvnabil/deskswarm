import { beforeEach, afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, createHash } from "node:crypto";
import { reset, get, post, del } from "./harness";
import { all, one, run } from "../src/db";
import {
  validateServer,
  sshOptions,
  serverById,
  configFor,
  connectionProbe,
  saveTestedServer,
} from "../src/servers";
import { providerByName } from "../src/providers";
import {
  docker,
  withDockerContext,
  serverBusy,
} from "../src/providers/docker-engine";
const private_key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();
const hostKey = Buffer.from("trusted-test-host-key");
const config = {
  name: "Remote Linux",
  host: "server.example.com",
  port: 22,
  username: "ubuntu",
  fingerprint:
    "SHA256:" +
    createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, ""),
  private_key,
  passphrase: "",
};
const realProbe = connectionProbe.info;
beforeEach(() => {
  reset();
  connectionProbe.info = async () => ({
    hostname: "remote",
    version: "28.0",
    architecture: "aarch64",
    cpus: 4,
    memory_mb: 8192,
    containers: 1,
  });
});
afterEach(() => {
  connectionProbe.info = realProbe;
});
async function connect() {
  const tested = await post("/api/v1/servers/test", { json: config });
  expect(tested.status, tested.text).toBe(200);
  return post("/api/v1/servers", {
    json: { ...config, test_token: tested.json.data.test_token },
  });
}

test("requires a validated SSH identity and pins the exact host key", () => {
  const verified = validateServer(config);
  const verifier = sshOptions(verified).hostVerifier as any;
  expect(verifier(hostKey)).toBe(true);
  expect(verifier(Buffer.from("other-host-key"))).toBe(false);
  for (const bad of [
    { host: "ssh://host;touch /tmp/x" },
    { port: 0 },
    { username: "root;false" },
    { fingerprint: "" },
    { private_key: "bad key" },
  ])
    expect(() => validateServer({ ...config, ...bad })).toThrow();
});
test("test then save encrypts the private key and never returns credentials", async () => {
  const saved = await connect();
  expect(saved.status).toBe(201);
  const row = serverById(saved.json.data.id)!;
  expect(row.secret).not.toContain(private_key);
  expect(configFor(row).private_key).toBe(private_key);
  const list = await get("/api/v1/servers");
  expect(list.json.data[0].provider).toBe("docker");
  expect(list.text).not.toContain("PRIVATE KEY");
  expect(saved.text).not.toContain("secret");
  expect((await get("/api/v1/servers", { noCookie: true })).status).toBe(401);
});
test("changed, expired and replayed connection tickets cannot save a server", async () => {
  const tested = await post("/api/v1/servers/test", { json: config });
  const token = tested.json.data.test_token;
  expect(
    (
      await post("/api/v1/servers", {
        json: { ...config, host: "other.example.com", test_token: token },
      })
    ).status,
  ).toBe(400);
  expect(
    (await post("/api/v1/servers", { json: { ...config, test_token: token } }))
      .status,
  ).toBe(201);
  expect(
    (await post("/api/v1/servers", { json: { ...config, test_token: token } }))
      .status,
  ).toBe(400);
  const fresh = await post("/api/v1/servers/test", { json: config });
  run("UPDATE server_tests SET expires_at=0");
  expect(
    (
      await post("/api/v1/servers", {
        json: { ...config, test_token: fresh.json.data.test_token },
      })
    ).status,
  ).toBe(400);
});
test("failed connection never produces a save ticket or a server row", async () => {
  connectionProbe.info = async () => {
    throw Error("Authentication failed");
  };
  const response = await post("/api/v1/servers/test", { json: config });
  expect(response.status).toBe(400);
  expect(all("SELECT * FROM servers").length).toBe(0);
  expect(all("SELECT * FROM server_tests").length).toBe(0);
});
test("a remote provider routes viewer URLs through authenticated SSH proxy and cannot be removed while in use", async () => {
  const saved = (await connect()).json.data;
  const provider = saved.provider;
  run(
    "INSERT INTO computers(name,slug,novnc_port,vnc_password,provider,created_at) VALUES('Remote','remote',6901,'password',?,datetime('now'))",
    provider,
  );
  const comp = one<any>("SELECT * FROM computers WHERE slug='remote'")!;
  const backend = providerByName(provider);
  expect(backend.name).toBe(provider);
  expect(backend.novncUrl(6901, "password")).toContain(
    `/remote-screen/${comp.id}/vnc.html`,
  );
  expect(backend.novncUrl(6901, "password")).not.toContain(config.host);
  expect((await del("/api/v1/servers/" + saved.id)).status).toBe(409);
  // Assets come from our pinned client, even when the host is unreachable.
  expect((await get(`/remote-screen/${comp.id}/vnc.html`)).status).toBe(200);
  const clientAsset = await get(`/remote-screen/${comp.id}/core/rfb.js`);
  const required=(await get(`/remote-screen/${comp.id}/mandatory.json`)).json;
  expect(required.path).toBe(`/remote-screen/${comp.id}/websockify`);
  expect(required.host).toBe("");
  expect(clientAsset.status).toBe(200);
  expect(clientAsset.text).toContain("class RFB");
  expect((await get(`/remote-screen/${comp.id}/private.pem`)).status).toBe(404);

  expect(
    (await get(`/remote-screen/${comp.id}/vnc.html`, { noCookie: true }))
      .status,
  ).toBe(401);
  expect(
    (
      await get(`/remote-screen/${comp.id}/websockify`, {
        headers: { origin: "https://foreign.example" },
      })
    ).status,
  ).toBe(403);
  run("DELETE FROM computers WHERE id=?", comp.id);
  expect((await del("/api/v1/servers/" + saved.id)).status).toBe(200);
  expect(() => providerByName(provider)).toThrow();
});
test("concurrent Docker contexts do not leak a remote client into another server or local operations", async () => {
  const local = docker();
  const a: any = { client: { id: "a" }, serverId: 41, limitsSupported: null },
    b: any = { client: { id: "b" }, serverId: 42, limitsSupported: null };
  const [first, second] = await Promise.all([
    withDockerContext(a, async () => {
      expect(serverBusy(41)).toBe(true);
      await Bun.sleep(15);
      return docker();
    }),
    withDockerContext(b, async () => {
      await Bun.sleep(5);
      return docker();
    }),
  ]);
  expect(first).toBe(a.client);
  expect(second).toBe(b.client);
  expect(docker()).toBe(local);
  expect(serverBusy(41)).toBe(false);
});

test("the real SSH transport carries Docker HTTP without leaking onto a TCP Docker API", async () => {
  const { Server, utils } = await import("ssh2");
  const { remoteDocker } = await import("../src/servers");
  const parsed = utils.parseKey(private_key);
  if (parsed instanceof Error) throw parsed;
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  const ssh = new Server({ hostKeys: [private_key] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => ctx.accept());
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (accept, reject, info) => {
          if (info.command !== "docker system dial-stdio") {
            reject();
            return;
          }
          const channel = accept();
          let request = "";
          let answered = false;
          channel.on("data", (chunk: Buffer) => {
            request += chunk.toString();
            if (answered || !request.includes("\r\n\r\n")) return;
            answered = true;
            const body = JSON.stringify({
              Name: "SSH Linux",
              OSType: "linux",
              MemTotal: 8 * 1024 ** 3,
              NCPU: 4,
              Architecture: "arm64",
              ServerVersion: "test",
            });
            channel.end(
              `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
            );
          });
        });
      }),
    );
  });
  await new Promise<void>((resolve) => ssh.listen(0, "127.0.0.1", resolve));
  try {
    const client = remoteDocker({
      ...config,
      host: "127.0.0.1",
      port: (ssh.address() as any).port,
      fingerprint:
        "SHA256:" +
        createHash("sha256")
          .update(key.getPublicSSH())
          .digest("base64")
          .replace(/=+$/, ""),
    });
    const info = await client.info();
    expect(info.Name).toBe("SSH Linux");
    expect(info.OSType).toBe("linux");
  } finally {
    ssh.close();
  }
});

test("guest control grants reach only their remote desktop and are refused after revocation", async () => {
  const saved = (await connect()).json.data;
  run(
    "INSERT INTO computers(name,slug,novnc_port,vnc_password,provider,created_at) VALUES('Guest remote','guest-remote',6901,'password',?,datetime('now'))",
    saved.provider,
  );
  const comp = one<any>("SELECT * FROM computers WHERE slug='guest-remote'")!;
  const share = (
    await post(`/api/v1/computers/${comp.id}/shares`, {
      json: { label: "guest", mode: "control", hours: 1 },
    })
  ).json.data;
  const page = await get(`/s/${share.token}`, { noCookie: true });
  const cookie = page.headers.get("set-cookie")!.split(";")[0];
  expect(cookie).toContain(`deskswarm_screen_${comp.id}=`);
  const guest = { noCookie: true, headers: { cookie } };
  expect((await get(`/remote-screen/${comp.id}/vnc.html`, guest)).status).toBe(
    200,
  );
  expect((await get("/api/v1/computers", guest)).status).toBe(401);
  expect(
    (await get(`/remote-screen/${comp.id + 1}/vnc.html`, guest)).status,
  ).toBe(401);
  await del(`/api/v1/shares/${share.id}`);
  expect((await get(`/remote-screen/${comp.id}/vnc.html`, guest)).status).toBe(
    401,
  );
});

test("static asset serving cannot reach private data paths", async () => {
  expect((await get("/static/dashboard.js")).status).toBe(200);
  expect(
    (await get("/static/icons/%2e%2e%2f%2e%2e%2fdata/.agent-secret-key"))
      .status,
  ).toBe(404);
  expect(
    (await get("/static/fonts/NotoSansArabic.ttf", { noCookie: true })).status,
  ).toBe(401);
});
