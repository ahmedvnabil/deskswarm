import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createCliManagement,
  stagedLogin,
  officialLoginUrl,
  failureReason,
  type spawnCli,
} from "../scripts/cli-management";
function fakeSpawner() {
  const children: any[] = [];
  const spawn = ((bin: string, args: string[]) => {
    const c: any = new EventEmitter();
    Object.assign(c, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      args,
      kill: () => {
        queueMicrotask(() => c.emit("close", 137));
        return true;
      },
    });
    children.push(c);
    if (args.includes("status"))
      queueMicrotask(() => {
        c.stdout.write("Logged in. private-account@example.com");
        c.emit("close", 0);
      });
    return c;
  }) as typeof spawnCli;
  return { spawn, children };
}
const req = (path: string, body?: unknown) =>
  new Request("http://gateway/management/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const wait = () => new Promise((r) => setTimeout(r, 10));
test("status exposes presence without account data and test proves actual inference", async () => {
  const f = fakeSpawner();
  let finish: any;
  const m = createCliManagement("codex", {
    spawn: f.spawn,
    loginStore: () => ({ env: {}, commit: () => {}, cleanup: () => {} }),
    busy: () => false,
    test: () => new Promise<void>((r) => (finish = r)),
  });
  let s = await (await m.handle(req("status")))!.json();
  expect(s.auth.state).toBe("signed_in");
  expect(JSON.stringify(s)).not.toContain("private-account");
  expect(s.test.state).toBe("untested");
  expect((await m.handle(req("test", { model: "default" })))!.status).toBe(202);
  expect((await m.handle(req("login", {})))!.status).toBe(409);
  finish();
  await wait();
  s = await (await m.handle(req("status")))!.json();
  expect(s.test.state).toBe("connected");
});
test("Claude callback is bound to current state, secrets not returned, cancel preserves login", async () => {
  const f = fakeSpawner();
  const m = createCliManagement("claude", {
    spawn: f.spawn,
    loginStore: () => ({ env: {}, commit: () => {}, cleanup: () => {} }),
    busy: () => false,
    test: async () => {},
  });
  const r = await (await m.handle(req("login", {})))!.json();
  const child = f.children[0];
  child.stdout.write(
    "https://claude.com/cai/oauth/authorize?response_type=code&state=1234567890_state\n",
  );
  expect(
    (await m.handle(
      req("login/complete", {
        id: r.login.id,
        code: "abcdefghijk#wrong_state",
      }),
    ))!.status,
  ).toBe(400);
  let written = "";
  child.stdin.on("data", (b: Buffer) => (written += b));
  const code = "privatecode123#1234567890_state";
  const done = await m.handle(req("login/complete", { id: r.login.id, code }));
  expect(done!.status).toBe(202);
  expect(await done!.text()).not.toContain("privatecode123");
  expect(written).toBe(code + "\n");
  child.emit("close", 0);
  const s = await (await m.handle(req("status")))!.json();
  expect(s.login.state).toBe("completed");
  expect(s.login.url).toBeUndefined();
  await m.handle(req("login", {}));
  const cancelled = await (await m.handle(req("login/cancel", {})))!.json();
  expect(cancelled.login.state).toBe("cancelled");
  expect(f.children.every((c) => !c.args.includes("logout"))).toBe(true);
  await wait();
});
test("Codex device link/code parsed, unsafe links rejected, login expires", async () => {
  const f = fakeSpawner();
  const m = createCliManagement("codex", {
    spawn: f.spawn,
    loginStore: () => ({ env: {}, commit: () => {}, cleanup: () => {} }),
    busy: () => false,
    test: async () => {},
    loginMs: 20,
  });
  await m.handle(req("login", {}));
  f.children[0].stdout.write(
    "https://auth.openai.com/codex/device\nABCD-12345\n",
  );
  let s = await (await m.handle(req("status")))!.json();
  expect(s.login.code).toBe("ABCD-12345");
  expect(s.login.url).toBe("https://auth.openai.com/codex/device");
  await new Promise((r) => setTimeout(r, 30));
  s = await (await m.handle(req("status")))!.json();
  expect(s.login.state).toBe("expired");
  expect(s.login.code).toBeUndefined();
  expect(
    officialLoginUrl("codex", "https://auth.openai.com.evil.test/codex/device"),
  ).toBeNull();
  expect(officialLoginUrl("claude", "javascript:alert(1)")).toBeNull();
});
test("busy inference blocks login and failures are classified without leaking output", async () => {
  const f = fakeSpawner();
  const blocked = createCliManagement("codex", {
    spawn: f.spawn,
    loginStore: () => ({ env: {}, commit: () => {}, cleanup: () => {} }),
    busy: () => true,
    test: async () => {},
  });
  expect((await blocked.handle(req("login", {})))!.status).toBe(409);
  expect(f.children).toHaveLength(0);
  const m = createCliManagement("claude", {
    spawn: f.spawn,
    loginStore: () => ({ env: {}, commit: () => {}, cleanup: () => {} }),
    busy: () => false,
    test: async () => {
      throw Error("401 secret-token");
    },
  });
  await m.handle(req("test", {}));
  await wait();
  const s = await (await m.handle(req("status")))!.json();
  expect(s.test.state).toBe("failed");
  expect(s.test.reason).toContain("تسجيل الدخول");
  expect(JSON.stringify(s)).not.toContain("secret-token");
  expect(failureReason("429 private")).toContain("حد الاستخدام");
});

test("destructive login cannot remove the active cache; only success promotes credentials", () => {
  const home = mkdtempSync(join(tmpdir(), "login-test-")),
    target = join(home, ".codex");
  mkdirSync(target);
  const old = join(target, "auth.json");
  writeFileSync(old, '{"session":"old"}');
  const cancelled = stagedLogin("codex", home, target);
  expect(cancelled.env.CODEX_HOME).not.toBe(target);
  writeFileSync(
    join(cancelled.env.CODEX_HOME!, "auth.json"),
    '{"session":"pending"}',
  );
  cancelled.cleanup();
  expect(JSON.parse(readFileSync(old, "utf8")).session).toBe("old");
  const success = stagedLogin("codex", home, target);
  try {
    writeFileSync(
      join(success.env.CODEX_HOME!, "auth.json"),
      '{"session":"new"}',
    );
    success.commit();
    expect(JSON.parse(readFileSync(old, "utf8")).session).toBe("new");
    expect(statSync(old).mode & 0o777).toBe(0o600);
  } finally {
    success.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});
