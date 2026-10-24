// Real workerd + SQLite Durable Objects, no Cloudflare account or credentials.
import { Miniflare } from "miniflare";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
let observed;
const origin = createServer(async (req, res) => {
  observed = { path: req.url, headers: req.headers };
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end('{"status":"ok"}');
    return;
  }
  if (req.url === "/redirect") {
    res.writeHead(302, {
      location: `http://127.0.0.1:${origin.address().port}/login`,
    });
    res.end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader(
    "set-cookie",
    "deskswarm_session=fixture; HttpOnly; SameSite=Lax; Secure; Path=/",
  );
  res.end(
    JSON.stringify({
      path: req.url,
      text: Buffer.concat(chunks).toString("utf8"),
    }),
  );
});
const wss = new WebSocketServer({ server: origin });
wss.on("connection", (ws) => ws.on("message", (data) => ws.send(data)));
await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
const mf = new Miniflare({
  modules: true,
  script: readFileSync(
    new URL("../src/cloudflare/worker.js", import.meta.url),
    "utf8",
  ),
  compatibilityDate: "2026-07-30",
  bindings: {
    ORIGIN: `http://127.0.0.1:${origin.address().port}`,
    EDGE_SECRET: "local-fixture-secret",
    RELEASE: "fixture-release",
  },
  durableObjects: { DEVICES: { className: "DeviceSession", useSQLite: true } },
});
try {
  const denied = await mf.dispatchFetch("https://edge.example/_edge/health");
  assert.equal(denied.status, 401);
  const health = await mf.dispatchFetch("https://edge.example/_edge/health", {
    headers: { authorization: "Bearer local-fixture-secret" },
  });
  assert.equal((await health.json()).release, "fixture-release");
  const response = await mf.dispatchFetch(
    "https://edge.example/api/v1/computers/7/exec?x=1",
    {
      method: "POST",
      headers: {
        cookie: "deskswarm_session=fixture",
        origin: "https://edge.example",
        "x-forwarded-host": "attacker.example",
        "x-deskswarm-edge": "injected",
      },
      body: "نجاح العربية",
    },
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.text, "نجاح العربية");
  assert.equal(data.path, "/api/v1/computers/7/exec?x=1");
  assert.equal(observed.headers["x-forwarded-host"], "edge.example");
  assert.equal(observed.headers["x-forwarded-proto"], "https");
  assert.equal(observed.headers["x-deskswarm-edge"], undefined);
  assert.equal(observed.headers.cookie, "deskswarm_session=fixture");
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const redirect = await mf.dispatchFetch("https://edge.example/redirect", {
    redirect: "manual",
  });
  assert.equal(redirect.headers.get("location"), "https://edge.example/login");
  const socket = await mf.dispatchFetch(
    "https://edge.example/remote-screen/7/websockify",
    { headers: { Upgrade: "websocket", Origin: "https://edge.example" } },
  );
  assert.equal(socket.status, 101);
  socket.webSocket.accept();
  const received = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(Error("WebSocket timed out")),
      5000,
    );
    socket.webSocket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        resolve(event.data);
      },
      { once: true },
    );
  });
  socket.webSocket.send("screen-roundtrip");
  assert.equal(Buffer.from(await received).toString(), "screen-roundtrip");
  socket.webSocket.close();
  console.log(
    "PASS: real Worker + SQLite Durable Object, Linux HTTP proxy, cookies, Arabic, redirects, WebSocket roundtrip",
  );
} finally {
  await mf.dispose();
  wss.close();
  await new Promise((resolve) => origin.close(resolve));
}
