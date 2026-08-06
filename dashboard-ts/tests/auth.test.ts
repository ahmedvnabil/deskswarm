/**
 * The login.
 *
 * This is the gate in front of a dashboard that can run commands as root
 * inside every machine it manages, so the tests that matter most are the
 * negative ones: what a request without a session can still reach, and what it
 * cannot.
 */
import { beforeEach, expect, test } from "bun:test";
import { TEST_PASSWORD, TEST_USER, addMachine, get, post, reset } from "./harness";
import * as auth from "../src/auth";
import { app } from "../src/app";

beforeEach(reset);

/** A request carrying no cookie and no token — a stranger with the URL. */
async function anon(
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {},
) {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers: { host: "localhost", ...opts.headers },
      body: opts.body,
      redirect: "manual",
    }),
  );
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const form = (fields: Record<string, string>) =>
  new URLSearchParams(fields).toString();
const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

test("an api request without a session is refused", async () => {
  const r = await anon("/api/v1/computers", { headers: { accept: "application/json" } });
  expect(r.status).toBe(401);
  expect(JSON.parse(r.text).error).toBe("unauthorized");
});

test("reading the fleet used to be open and is not any more", async () => {
  // Every one of these answered 200 to anyone who could reach the port.
  for (const path of [
    "/api/v1/computers", "/api/v1/keys", "/api/v1/audit", "/api/v1/shares",
    "/api/v1/guards", "/partials/fleet", "/partials/audit", "/partials/activity",
  ]) {
    const r = await anon(path, { headers: { accept: "application/json" } });
    expect(`${path} -> ${r.status}`).toBe(`${path} -> 401`);
  }
});

test("a browser is redirected to the login page, not given json", async () => {
  const r = await anon("/", { headers: { accept: "text/html" } });
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe("/login?next=%2F");
});

test("the health check stays public", async () => {
  // The container healthcheck has no cookie to offer.
  const r = await anon("/health");
  expect(r.status).toBe(200);
  expect(JSON.parse(r.text).status).toBe("ok");
});

test("a share link still works without an account", async () => {
  // That is the whole feature: a link you hand to someone who has no login.
  const id = (await addMachine("shared")).json.data.id;
  const share = (await post(`/api/v1/computers/${id}/shares`, { json: { label: "sara" } }))
    .json.data;
  const r = await anon(`/s/${share.token}`, { headers: { accept: "text/html" } });
  expect(r.status).toBe(200);
  expect(r.text).toContain("shared");
});

test("a wrong password and an unknown user are indistinguishable", async () => {
  const wrongPassword = await anon("/login", {
    method: "POST", headers: FORM_HEADERS,
    body: form({ username: TEST_USER, password: "not-the-password" }),
  });
  const noSuchUser = await anon("/login", {
    method: "POST", headers: FORM_HEADERS,
    body: form({ username: "ghost", password: "not-the-password" }),
  });
  expect(wrongPassword.status).toBe(401);
  expect(noSuchUser.status).toBe(401);
  // Same status, same words. The pages are not byte-identical only because
  // the form echoes back whatever was typed in the username box, which tells
  // the sender nothing they did not already know.
  expect(wrongPassword.text).toContain("wrong username or password");
  expect(noSuchUser.text).toContain("wrong username or password");
  const strip = (t: string, name: string) => t.replace(`value="${name}"`, 'value=""');
  expect(strip(noSuchUser.text, "ghost")).toBe(strip(wrongPassword.text, TEST_USER));
  for (const leak of ["no such user", "unknown user", "user not found", "incorrect password"]) {
    expect(noSuchUser.text.toLowerCase()).not.toContain(leak);
  }
});

test("signing in gives a session cookie that then works", async () => {
  const r = await anon("/login", {
    method: "POST", headers: FORM_HEADERS,
    body: form({ username: TEST_USER, password: TEST_PASSWORD, next: "/partials/fleet" }),
  });
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe("/partials/fleet");

  const cookie = r.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");

  const token = cookie.split(";")[0];
  const after = await anon("/api/v1/computers", {
    headers: { accept: "application/json", cookie: token },
  });
  expect(after.status).toBe(200);
});

test("next is not an open redirect", async () => {
  // `next=https://evil.example` would let the login page lend its domain to a
  // phishing hop; `//evil.example` is a path to a careless check and a host to
  // a browser.
  for (const evil of ["https://evil.example/x", "//evil.example/x"]) {
    const r = await anon("/login", {
      method: "POST", headers: FORM_HEADERS,
      body: form({ username: TEST_USER, password: TEST_PASSWORD, next: evil }),
    });
    expect(r.headers.get("location")).toBe("/");
  }
});

test("logging out ends the session everywhere", async () => {
  const login = await anon("/login", {
    method: "POST", headers: FORM_HEADERS,
    body: form({ username: TEST_USER, password: TEST_PASSWORD }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  expect((await anon("/api/v1/computers", { headers: { accept: "application/json", cookie } })).status).toBe(200);
  await anon("/logout", { method: "POST", headers: { cookie } });
  expect((await anon("/api/v1/computers", { headers: { accept: "application/json", cookie } })).status).toBe(401);
});

test("guessing is rate limited", async () => {
  for (let i = 0; i < auth.MAX_ATTEMPTS; i++) {
    await anon("/login", {
      method: "POST", headers: FORM_HEADERS,
      body: form({ username: TEST_USER, password: `guess-${i}` }),
    });
  }
  const blocked = await anon("/login", {
    method: "POST", headers: FORM_HEADERS,
    body: form({ username: TEST_USER, password: TEST_PASSWORD }),
  });
  expect(blocked.status).toBe(429);
  expect(blocked.text).toContain("too many attempts");
});

test("a script with the api token needs no session", async () => {
  // n8n and cron were here before the login page was.
  const r = await anon("/api/v1/computers", {
    headers: { accept: "application/json", authorization: "Bearer test-api-token-9f2c" },
  });
  expect(r.status).toBe(200);
});

test("a wrong api token is refused", async () => {
  const r = await anon("/api/v1/computers", {
    headers: { accept: "application/json", authorization: "Bearer nearly-right" },
  });
  expect(r.status).toBe(401);
});

test("changing a password signs every browser out", async () => {
  // A password change is usually a response to it having leaked.
  const login = await anon("/login", {
    method: "POST", headers: FORM_HEADERS,
    body: form({ username: TEST_USER, password: TEST_PASSWORD }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  expect((await anon("/api/v1/computers", { headers: { accept: "application/json", cookie } })).status).toBe(200);

  await auth.setPassword(TEST_USER, "a-brand-new-password");
  expect((await anon("/api/v1/computers", { headers: { accept: "application/json", cookie } })).status).toBe(401);
});

test("an expired session is not a session", async () => {
  const { run } = await import("../src/db");
  const { nowIso } = await import("../src/settings");
  const user = auth.findUser(TEST_USER)!;
  const token = auth.startSession(user.id, "127.0.0.1", "test");
  run(
    "UPDATE sessions SET expires_at = ? WHERE user_id = ?",
    nowIso(new Date(Date.now() - 60_000)),
    user.id,
  );
  expect(auth.resolveSession(token)).toBeNull();
});

test("a short password is refused", async () => {
  // This login reaches a root shell on every machine, so the usual eight is
  // not the right number.
  expect(auth.createUser("shorty", "sixchars")).rejects.toThrow("at least 12");
});

test("a bad username is refused", async () => {
  expect(auth.createUser("Not A Name!", "long-enough-password")).rejects.toThrow("username must be");
});

test("the last user cannot delete themselves into a locked dashboard", async () => {
  expect(() => auth.deleteUser(TEST_USER)).toThrow("last user");
});

test("the bootstrap makes exactly one user, once", async () => {
  const { run } = await import("../src/db");
  run("DELETE FROM users");
  process.env.DESKSWARM_ADMIN_USER = "boss";
  process.env.DESKSWARM_ADMIN_PASSWORD = "bootstrap-password-1";
  await auth.ensureAdmin();
  await auth.ensureAdmin(); // a restart must not add a second
  expect(auth.listUsers().map((u) => u.username)).toEqual(["boss"]);
  delete process.env.DESKSWARM_ADMIN_USER;
  delete process.env.DESKSWARM_ADMIN_PASSWORD;
});

test("a signed-in person is named in the audit trail", async () => {
  await addMachine("named");
  const rows = (await get("/api/v1/audit")).json.data;
  expect(rows[0].actor).toBe(TEST_USER);
});

test("the login page does not null its own Origin", async () => {
  // `no-referrer` makes a browser send `Origin: null` on the page's own form
  // post, which the cross-site check refuses — so the login page locked
  // everyone out of the login. The tests missed it because they post with an
  // explicit, matching Origin; a real browser found it in minutes.
  const page = await anon("/login", { headers: { accept: "text/html" } });
  expect(page.text).not.toContain('content="no-referrer"');
  expect(page.text).toContain('content="same-origin"');
});

test("a null Origin is still refused", async () => {
  // Fixing the page is the fix; accepting `null` is not. It is what a
  // sandboxed iframe and a cross-origin redirect both send.
  const r = await anon("/login", {
    method: "POST",
    headers: { Origin: "null", "content-type": "application/x-www-form-urlencoded" },
    body: form({ username: TEST_USER, password: TEST_PASSWORD }),
  });
  expect(r.status).toBe(403);
});
