/** Private gateway management. Never returns CLI output or auth-cache contents. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
export type CliKind = "claude" | "codex";
export type Check = {
  state: string;
  reason: string;
  checked_at: string;
  model?: string;
};
export type Login = {
  id: string;
  state: string;
  reason: string;
  url?: string;
  code?: string;
  expires_at: string;
};
export { failureReason } from "./provider-errors";
import { failureReason } from "./provider-errors";
export function officialLoginUrl(kind: CliKind, value: string) {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    if (
      kind === "codex" &&
      u.hostname === "auth.openai.com" &&
      u.pathname === "/codex/device" &&
      !u.search &&
      !u.hash
    )
      return u.href;
    if (
      kind === "claude" &&
      ["claude.ai", "claude.com"].includes(u.hostname) &&
      ["/oauth/authorize", "/cai/oauth/authorize"].includes(u.pathname) &&
      u.searchParams.get("response_type") === "code"
    )
      return u.href;
  } catch {}
  return null;
}
export const spawnCli = (
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) => {
  const child = spawn(bin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    detached: process.platform !== "win32",
  });
  const kill = child.kill.bind(child);
  child.kill = (signal = "SIGTERM") => {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {}
    }
    return kill(signal);
  };
  return child;
};
// Some CLI login commands delete the existing cache before approval. Isolate
// that behavior and promote only the newly authenticated cache after success.
export function stagedLogin(
  kind: CliKind,
  home = process.env.HOME || homedir(),
  target?: string,
) {
  const dir = mkdtempSync(join(tmpdir(), "deskswarm-login-"));
  const config = join(dir, kind === "codex" ? ".codex" : ".claude");
  mkdirSync(config, { mode: 0o700 });
  const dest =
    target ||
    (kind === "codex"
      ? process.env.CODEX_HOME
      : process.env.CLAUDE_CONFIG_DIR) ||
    join(home, kind === "codex" ? ".codex" : ".claude");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    ...(kind === "codex"
      ? { CODEX_HOME: config }
      : { CLAUDE_CONFIG_DIR: config }),
  };
  return {
    env,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    commit: () => {
      const name = kind === "codex" ? "auth.json" : ".credentials.json";
      const bytes = readFileSync(join(config, name));
      const parsed = JSON.parse(bytes.toString());
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !Object.keys(parsed).length
      )
        throw Error("Invalid auth cache");
      mkdirSync(dest, { recursive: true, mode: 0o700 });
      const temp = join(dest, `.login-${randomUUID()}`);
      try {
        writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
        renameSync(temp, join(dest, name));
      } finally {
        rmSync(temp, { force: true });
      }
    },
  };
}
export function createCliManagement(
  kind: CliKind,
  options: {
    busy: () => boolean;
    test: (model: string) => Promise<void>;
    bin?: string;
    spawn?: typeof spawnCli;
    loginMs?: number;
    loginStore?: () => ReturnType<typeof stagedLogin>;
  },
) {
  const bin =
    options.bin || process.env[`DESKSWARM_${kind.toUpperCase()}_BIN`] || kind;
  const start = options.spawn || spawnCli;
  let login: Login | null = null,
    loginProcess: ReturnType<typeof spawnCli> | null = null;
  let test: Check = {
    state: "untested",
    reason: "لم يتم اختبار استجابة الموديل بعد.",
    checked_at: "",
  };
  let checking = false;
  let authPromise: Promise<Check> | null = null,
    cachedAuth: Check | null = null;
  const stamp = () => new Date().toISOString();
  async function auth(): Promise<Check> {
    if (cachedAuth && Date.now() - Date.parse(cachedAuth.checked_at) < 5000)
      return cachedAuth;
    if (authPromise) return authPromise;
    authPromise = new Promise<Check>((resolve) => {
      let output = "",
        settled = false;
      const done = (state: string, reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cachedAuth = { state, reason, checked_at: stamp() };
        resolve(cachedAuth);
      };
      let child: ReturnType<typeof spawnCli>;
      const timer = setTimeout(() => {
        child?.kill("SIGKILL");
        done("error", "انتهت مهلة فحص تسجيل الدخول. أعد المحاولة.");
      }, 10000);
      try {
        child = start(
          bin,
          kind === "codex" ? ["login", "status"] : ["auth", "status", "--text"],
        );
        const collect = (b: Buffer) => {
          output = (output + b.toString()).slice(-16000);
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.stdin.end();
        child.on("error", () =>
          done(
            "error",
            "برنامج المزوّد غير متاح على السيرفر. تحقق من تثبيته ومساره.",
          ),
        );
        child.on("close", (code) =>
          done(
            code === 0 ? "signed_in" : "signed_out",
            code === 0
              ? "تسجيل الدخول موجود على السيرفر؛ اختبار الموديل يؤكد الاتصال الفعلي."
              : failureReason(output),
          ),
        );
      } catch {
        done("error", "تعذر تشغيل برنامج المزوّد على السيرفر.");
      }
    }).finally(() => {
      authPromise = null;
    });
    return authPromise;
  }
  async function status() {
    return {
      provider: kind,
      auth: await auth(),
      test,
      busy: options.busy() || checking,
      login,
    };
  }
  return {
    loginActive: () => login?.state === "pending",
    async handle(req: Request): Promise<Response | null> {
      const path = new URL(req.url).pathname;
      if (!path.startsWith("/management/")) return null;
      const headers = { "cache-control": "no-store" };
      const json = (data: unknown, status = 200) =>
        Response.json(data, { status, headers });
      if (path === "/management/status" && req.method === "GET")
        return json(await status());
      if (path === "/management/test" && req.method === "POST") {
        const body: any = await req.json().catch(() => ({}));
        if (options.busy() || checking || login?.state === "pending")
          return json(
            {
              error:
                "المزوّد مشغول بمهمة أو تسجيل دخول. انتظر ثم أعد المحاولة.",
            },
            409,
          );
        const model = String(body.model || "default");
        if (model.length > 200)
          return json({ error: "Model ID too long" }, 400);
        checking = true;
        test = {
          state: "checking",
          reason: "جارٍ إرسال طلب صغير للموديل؛ قد يُحتسب من استخدام الحساب.",
          checked_at: stamp(),
          model,
        };
        void options
          .test(model)
          .then(
            () => {
              test = {
                state: "connected",
                reason: "نجح تسجيل الدخول وردّ الموديل من السيرفر.",
                checked_at: stamp(),
                model,
              };
            },
            (err) => {
              test = {
                state: "failed",
                reason: failureReason(String(err?.message || "")),
                checked_at: stamp(),
                model,
              };
            },
          )
          .finally(() => {
            checking = false;
          });
        return json({ provider: kind, test }, 202);
      }
      if (path === "/management/login" && req.method === "POST") {
        if (login?.state === "pending") return json({ login }, 202);
        if (options.busy() || checking)
          return json(
            {
              error:
                "أوقف مهمة المزوّد أو انتظر اكتمال الاختبار قبل تسجيل الدخول.",
            },
            409,
          );
        const ms = options.loginMs || 15 * 60 * 1000;
        const current: Login = {
          id: randomUUID(),
          state: "pending",
          reason: "جارٍ تجهيز رابط تسجيل الدخول الرسمي…",
          expires_at: new Date(Date.now() + ms).toISOString(),
        };
        login = current;
        let stage: ReturnType<typeof stagedLogin> | undefined;
        let output = "",
          timer: ReturnType<typeof setTimeout>;
        const finish = (state: string, reason: string) => {
          clearTimeout(timer);
          if (current.state !== "pending") {
            stage?.cleanup();
            return;
          }
          if (state === "completed") {
            try {
              stage?.commit();
            } catch {
              state = "failed";
              reason =
                "نجحت الموافقة لكن تعذر حفظ الجلسة على السيرفر. راجع صلاحيات مجلد الخدمة وأعد المحاولة.";
            }
          }
          stage?.cleanup();
          current.state = state;
          current.reason = reason;
          delete current.url;
          delete current.code;
          loginProcess = null;
          cachedAuth = null;
          if (state === "completed")
            test = {
              state: "untested",
              reason: "تم تسجيل الدخول. اختبر الاتصال للتأكد من ردّ الموديل.",
              checked_at: "",
            };
        };
        try {
          stage = options.loginStore ? options.loginStore() : stagedLogin(kind);
          const child = start(
            bin,
            kind === "codex"
              ? ["login", "--device-auth"]
              : ["auth", "login", "--claudeai"],
            stage.env,
          );
          loginProcess = child;
          timer = setTimeout(() => {
            current.state = "expired";
            current.reason =
              "انتهت صلاحية طلب الدخول. اضغط إعادة تسجيل الدخول لطلب رابط جديد.";
            delete current.url;
            delete current.code;
            loginProcess = null;
            child.kill("SIGKILL");
          }, ms);
          const collect = (b: Buffer) => {
            if (current.state !== "pending") return;
            output = (output + b.toString())
              .replace(/\x1b\[[0-9;]*m/g, "")
              .slice(-24000);
            for (const value of output.match(/https:\/\/[^\s\x1b<>]+/g) || []) {
              const url = officialLoginUrl(kind, value);
              if (url) {
                current.url = url;
                current.reason =
                  kind === "codex"
                    ? "افتح الرابط الرسمي وأدخل رمز الجهاز، ثم وافق. ستتحدث الحالة تلقائيًا."
                    : "افتح الرابط الرسمي ووافق، ثم الصق كود الربط أو رابط صفحة النتيجة أدناه.";
              }
            }
            if (kind === "codex") {
              const code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/);
              if (code) current.code = code[0];
            }
          };
          child.stdout.on("data", collect);
          child.stderr.on("data", collect);
          child.on("error", () =>
            finish(
              "failed",
              "تعذر تشغيل تسجيل الدخول. تحقق من تثبيت برنامج المزوّد على السيرفر.",
            ),
          );
          child.on("close", (code) =>
            finish(
              code === 0 ? "completed" : "failed",
              code === 0
                ? "تم حفظ تسجيل الدخول على السيرفر. اختبر الاتصال الآن."
                : failureReason(output),
            ),
          );
        } catch {
          finish("failed", "تعذر بدء تسجيل الدخول على السيرفر.");
        }
        return json({ login }, 202);
      }
      if (path === "/management/login/complete" && req.method === "POST") {
        const body: any = await req.json().catch(() => ({}));
        if (
          kind !== "claude" ||
          !loginProcess ||
          login?.state !== "pending" ||
          body.id !== login.id
        )
          return json({ error: "طلب الدخول غير نشط. ابدأ طلبًا جديدًا." }, 409);
        let code = String(body.code || "").trim();
        if (code.startsWith("https://")) {
          try {
            const u = new URL(code);
            if (
              u.origin !== "https://platform.claude.com" ||
              u.pathname !== "/oauth/code/callback"
            )
              throw Error();
            code =
              u.searchParams.get("code") + "#" + u.searchParams.get("state");
          } catch {
            return json(
              { error: "استخدم كود الربط أو رابط النتيجة الرسمي فقط." },
              400,
            );
          }
        }
        const parts = code.split("#");
        const state = login.url
          ? new URL(login.url).searchParams.get("state")
          : null;
        if (
          parts.length !== 2 ||
          !parts.every((x) => /^[A-Za-z0-9_-]{10,256}$/.test(x)) ||
          !state ||
          parts[1] !== state
        )
          return json(
            {
              error:
                "كود غير صالح أو يخص طلب دخول سابق. استخدم كود الطلب الحالي.",
            },
            400,
          );
        if (loginProcess.stdin.destroyed)
          return json(
            { error: "قناة الربط أُغلقت. أعد بدء تسجيل الدخول." },
            409,
          );
        loginProcess.stdin.write(code + "\n");
        login.reason = "جارٍ تأكيد كود الربط على السيرفر…";
        return json({ login }, 202);
      }
      if (path === "/management/login/cancel" && req.method === "POST") {
        if (login?.state === "pending") {
          const child = loginProcess;
          login.state = "cancelled";
          login.reason = "تم إلغاء طلب الدخول؛ تسجيل الدخول السابق محفوظ.";
          delete login.url;
          delete login.code;
          loginProcess = null;
          child?.kill("SIGKILL");
        }
        return json({ login });
      }
      return json({ error: "not found" }, 404);
    },
  };
}
