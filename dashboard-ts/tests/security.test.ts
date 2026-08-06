/**
 * The dashboard can run shell commands as root inside a machine, so a
 * cross-site request reaching a mutating endpoint is remote code execution.
 * These tests pin that door shut.
 */
import { beforeEach, expect, test } from "bun:test";
import { addMachine, del, get, post, reset } from "./harness";

beforeEach(reset);

const EVIL = { Origin: "https://evil.example.com" };

test("a cross-site form post is rejected", async () => {
  // A plain HTML form post is a CORS "simple request" — no preflight stops it —
  // so the Origin check is the only thing between a malicious page and /exec.
  const r = await post("/api/v1/computers/1/exec", {
    body: "command=id",
    headers: { ...EVIL, "content-type": "application/x-www-form-urlencoded" },
  });
  expect(r.status).toBe(403);
  expect(r.json.error).toContain("cross-site");
});

test("a cross-site json post is rejected", async () => {
  expect((await post("/api/v1/tasks", { json: { description: "x" }, headers: EVIL })).status).toBe(403);
});

test("a cross-site delete is rejected", async () => {
  expect((await del("/api/v1/computers/1", { headers: EVIL })).status).toBe(403);
});

test("a same-origin request is allowed", async () => {
  const r = await post("/api/v1/computers", {
    json: { name: "same-origin" },
    headers: { Origin: "http://localhost" },
  });
  expect(r.status).toBe(201);
});

test("a client without Origin still works", async () => {
  // curl / n8n / cron send no Origin and are not a CSRF vector.
  expect((await addMachine("scripted")).status).toBe(201);
});

test("reads are never blocked", async () => {
  expect((await get("/api/v1/computers", { headers: EVIL })).status).toBe(200);
});

test("a form-encoded body cannot supply parameters", async () => {
  // Defence in depth: even same-origin, a form body is ignored, so a simple
  // request can never carry a command.
  await addMachine("box");
  const r = await post("/api/v1/computers/1/exec", {
    body: "command=id",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  expect(r.status).toBe(400);
  expect(r.json.error).toContain("command is required");
});

test("a blocked cross-site request still leaves an audit line", async () => {
  // It short-circuited before the audit hook ran, so the one category of
  // request most worth recording was the only one that vanished silently.
  await post("/api/v1/computers", { json: { name: "x" }, headers: EVIL });
  const rows = (await get("/api/v1/audit")).json.data;
  const blocked = rows.find((r: any) => r.status === 403);
  expect(blocked).toBeTruthy();
  expect(blocked.action).toBe("POST /api/v1/computers");
  expect(blocked.ok).toBe(0);
});

test("a proxy that rewrites Host does not make the real site look foreign", async () => {
  // nginx and Traefik can be configured to replace Host with the upstream
  // address; then every form post from the site itself is refused.
  const r = await post("/api/v1/computers", {
    json: { name: "behind-a-proxy" },
    headers: {
      host: "127.0.0.1:7861",
      "x-forwarded-host": "swarm.example.com",
      Origin: "https://swarm.example.com",
    },
  });
  expect(r.status).toBe(201);
});

test("a forged X-Forwarded-Host does not open the door", async () => {
  // A browser cannot set it on a simple request, but nothing is lost by
  // checking that a mismatch is still a mismatch.
  const r = await post("/api/v1/computers", {
    json: { name: "forged" },
    headers: { "x-forwarded-host": "evil.example", Origin: "https://other.example" },
  });
  expect(r.status).toBe(403);
});
