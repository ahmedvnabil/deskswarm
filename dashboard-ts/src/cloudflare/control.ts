import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { all, one, run, getDb } from "../db";
import { encryptSecret, decryptSecret } from "../agents/store";
import { nowIso } from "../settings";

export function initCloudflare() {
  getDb()
    .exec(`CREATE TABLE IF NOT EXISTS cloudflare_config(id INTEGER PRIMARY KEY CHECK(id=1), account TEXT NOT NULL, worker TEXT NOT NULL, origin TEXT NOT NULL, secret TEXT NOT NULL, edge_secret TEXT NOT NULL, tested_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cloudflare_jobs(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL, version TEXT, url TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS cloudflare_one_job ON cloudflare_jobs((1)) WHERE status='running';`);
}
export const cfTransport = {
  fetch: (url: string | URL | Request, init?: RequestInit) => fetch(url, init),
};
export function config() {
  return one("SELECT * FROM cloudflare_config WHERE id=1");
}
export function publicConfig() {
  const c = config();
  return c
    ? {
        account: c.account,
        worker: c.worker,
        origin: c.origin,
        tested_at: c.tested_at,
        has_token: true,
      }
    : null;
}
export function validate(body: Record<string, any>) {
  const account = String(body.account || "").trim();
  const worker = String(body.worker || "").trim();
  const token = String(body.token || "").trim();
  const origin = new URL(String(body.origin || ""));
  if (!/^[a-f0-9]{32}$/.test(account)) throw new Error("Account ID غير صالح");
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(worker))
    throw new Error(
      "اسم Worker: من 3 إلى 63 حرفًا إنجليزيًا صغيرًا أو رقمًا أو شرطة",
    );
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    origin.port ||
    /^(localhost|127\.|0\.|\[|169\.254\.|10\.|192\.168\.)/i.test(
      origin.hostname,
    )
  )
    throw new Error(
      "أدخل عنوان HTTPS عامًا لخدمة Linux بدون مسار أو بيانات دخول",
    );
  const storedToken =
    !token && config()?.account === account
      ? decryptSecret(config()!.secret)
      : token;
  if (!storedToken || storedToken.length > 4096 || /\s/.test(storedToken))
    throw new Error("أدخل API Token صالحًا");
  return { account, worker, origin: origin.origin, token: storedToken };
}
export async function requestCF(
  c: any,
  path: string,
  init: RequestInit = {},
  allowMissing = false,
) {
  const response = await cfTransport.fetch(
    `https://api.cloudflare.com/client/v4/${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${c.token || decryptSecret(c.secret)}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(90000),
      redirect: "error",
    },
  );
  if (allowMissing && response.status === 404) return null;
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Cloudflare HTTP ${response.status}`);
  }
  // Never return provider messages: they can echo submitted secrets or payloads.
  if (!response.ok || !data.success)
    throw new Error(
      `Cloudflare رفض الطلب (${response.status}؛ code ${Number(data.errors?.[0]?.code) || 0})`,
    );
  return data.result;
}
function api(
  c: any,
  path: string,
  init: RequestInit = {},
  allowMissing = false,
) {
  return requestCF(
    c,
    `accounts/${c.account}/workers/${path}`,
    init,
    allowMissing,
  );
}
export function accountInput(body: Record<string, any>) {
  const account = String(body.account || config()?.account || "").trim();
  const token =
    String(body.token || "").trim() ||
    (config()?.account === account ? decryptSecret(config()!.secret) : "");
  if (
    !/^[a-f0-9]{32}$/.test(account) ||
    !token ||
    token.length > 4096 ||
    /\s/.test(token)
  )
    throw new Error(
      "Account ID أو API Token غير صالح؛ أدخلهما أو استخدم الحساب المحفوظ",
    );
  return { account, token };
}
let tickets = new Map<string, { digest: string; expires: number }>();
function digest(c: any) {
  return createHash("sha256").update(JSON.stringify(c)).digest("hex");
}
export async function testConnection(c: ReturnType<typeof validate>) {
  const info = await api(c, "subdomain");
  if (!info?.subdomain) throw new Error("فعّل workers.dev للحساب أولًا");
  // Read access is tested now; actual write/DO entitlement is verified on deploy.
  await api(c, `scripts/${c.worker}/settings`, {}, true);
  const origin = await cfTransport.fetch(`${c.origin}/health`, {
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  const health: any = await origin.json().catch(() => null);
  if (!origin.ok || health?.status !== "ok")
    throw new Error("خدمة Linux لا تستجيب لفحص الصحة");
  const ticket = randomBytes(32).toString("hex");
  for (const [key, value] of tickets)
    if (value.expires < Date.now()) tickets.delete(key);
  if (tickets.size > 100) tickets.clear();
  tickets.set(ticket, { digest: digest(c), expires: Date.now() + 300000 });
  return {
    test_token: ticket,
    message:
      "الاتصال وقراءة الحساب وخدمة Linux نجحوا. صلاحيات الكتابة وDurable Objects تُفحص عند النشر.",
  };
}
export function saveConnection(c: ReturnType<typeof validate>, ticket: string) {
  if (one("SELECT id FROM cloudflare_jobs WHERE status='running'"))
    throw new Error("انتظر انتهاء النشر قبل تعديل الاتصال");
  const checked = tickets.get(ticket);
  tickets.delete(ticket);
  if (!checked || checked.expires < Date.now() || checked.digest !== digest(c))
    throw new Error("اختبر نفس الإعدادات قبل الحفظ");
  const previous = config();
  run(
    `INSERT OR REPLACE INTO cloudflare_config VALUES(1,?,?,?,?,?,?)`,
    c.account,
    c.worker,
    c.origin,
    encryptSecret(c.token),
    previous?.edge_secret || encryptSecret(randomBytes(32).toString("hex")),
    nowIso(),
  );
  return publicConfig();
}
export function jobs() {
  return all("SELECT * FROM cloudflare_jobs ORDER BY id DESC LIMIT 30");
}
function update(
  id: number,
  stage: string,
  extra: {
    status?: string;
    version?: string;
    url?: string;
    error?: string;
  } = {},
) {
  run(
    "UPDATE cloudflare_jobs SET stage=?,status=COALESCE(?,status),version=COALESCE(?,version),url=COALESCE(?,url),error=COALESCE(?,error),updated_at=? WHERE id=?",
    stage,
    extra.status || null,
    extra.version || null,
    extra.url || null,
    extra.error || null,
    nowIso(),
    id,
  );
}
export function recoverCloudflare() {
  initCloudflare();
  run(
    "UPDATE cloudflare_jobs SET status='interrupted',stage='انقطع التشغيل؛ افحص سجل Cloudflare قبل إعادة المحاولة',updated_at=? WHERE status='running'",
    nowIso(),
  );
}
export async function versions() {
  const c = config();
  if (!c) return [];
  const result = await api(c, `scripts/${c.worker}/versions`);
  return (result?.items || []).map((v: any) => ({
    id: v.id,
    created_at: v.metadata?.created_on,
  }));
}
export function startJob(kind: "deploy" | "rollback", version?: string) {
  const c = config();
  if (!c) throw new Error("اربط حساب Cloudflare أولًا");
  if (kind === "rollback" && !/^[a-f0-9-]{36}$/.test(version || ""))
    throw new Error("اختر إصدارًا صالحًا");
  if (one("SELECT id FROM cloudflare_jobs WHERE status='running'"))
    throw new Error("توجد عملية نشر جارية");
  const id = run(
    "INSERT INTO cloudflare_jobs(kind,status,stage,created_at,updated_at) VALUES(?,'running','بدء العملية',?,?)",
    kind,
    nowIso(),
    nowIso(),
  ).lastInsertRowid;
  void execute(id, c, kind, version).catch(() => {});
  return id;
}
export async function execute(
  id: number,
  c: any,
  kind: string,
  version?: string,
) {
  try {
    const script = `scripts/${c.worker}`;
    const subdomain = await api(c, "subdomain");
    const url = `https://${c.worker}.${subdomain.subdomain}.workers.dev`;
    if (new URL(c.origin).host === new URL(url).host)
      throw new Error("عنوان Linux لا يمكن أن يكون عنوان Worker نفسه");
    if (kind === "deploy") {
      update(id, "رفع Worker وربط Durable Objects");
      // Only initialize our namespace on a new Worker. Never overwrite another app.
      const settings = await api(c, `${script}/settings`, {}, true);
      const exists = !!settings;
      const migration = "deskswarm-v1";
      if (
        exists &&
        !settings.bindings?.some(
          (b: any) =>
            b.name === "DESKSWARM_APP" && b.text === "deskswarm-edge-v1",
        )
      )
        throw new Error("اسم Worker مستخدم لتطبيق آخر؛ اختر اسمًا جديدًا");
      const metadata: any = {
        main_module: "worker.js",
        compatibility_date: "2026-07-30",
        bindings: [
          {
            name: "DEVICES",
            type: "durable_object_namespace",
            class_name: "DeviceSession",
          },
          { name: "ORIGIN", type: "plain_text", text: c.origin },
          {
            name: "DESKSWARM_APP",
            type: "plain_text",
            text: "deskswarm-edge-v1",
          },
          { name: "RELEASE", type: "plain_text", text: `job-${id}` },
          {
            name: "EDGE_SECRET",
            type: "secret_text",
            text: decryptSecret(c.edge_secret),
          },
        ],
      };
      if (!exists)
        metadata.migrations = {
          new_tag: migration,
          new_sqlite_classes: ["DeviceSession"],
        };
      const form = new FormData();
      form.set(
        "metadata",
        new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      );
      form.set(
        "worker.js",
        new Blob(
          [readFileSync(new URL("./worker.js", import.meta.url), "utf8")],
          { type: "application/javascript+module" },
        ),
        "worker.js",
      );
      const uploaded = await api(c, script, { method: "PUT", body: form });
      version = uploaded.version_id;
      if (!version) {
        const active = await api(c, `${script}/deployments`);
        version = active?.deployments?.[0]?.versions?.[0]?.version_id;
      }
      if (!version)
        throw new Error(
          "Cloudflare لم يُرجع معرف الإصدار؛ افحص لوحة Cloudflare",
        );
      update(id, "تفعيل workers.dev", { version, url });
      await api(c, `${script}/subdomain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, previews_enabled: false }),
      });
    } else {
      update(id, "إعادة توجيه كامل الزيارات للإصدار المحدد");
      const settings = await api(c, `${script}/settings`);
      if (
        !settings.bindings?.some(
          (b: any) =>
            b.name === "DESKSWARM_APP" && b.text === "deskswarm-edge-v1",
        )
      )
        throw new Error("اسم Worker مستخدم لتطبيق آخر؛ اختر اسمًا جديدًا");
      const available = await versions();
      if (!available.some((v: any) => v.id === version))
        throw new Error("الإصدار غير موجود في الحساب الحالي");
      await api(c, `${script}/deployments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy: "percentage",
          versions: [{ version_id: version, percentage: 100 }],
        }),
      });
      update(id, "فحص الإصدار بعد الرجوع", { version, url });
    }
    const active = await api(c, `${script}/deployments`);
    if (
      !active?.deployments?.[0]?.versions?.some(
        (v: any) => v.version_id === version && v.percentage === 100,
      )
    )
      throw new Error("Cloudflare لم يؤكد تفعيل الإصدار بالكامل");
    update(id, "التحقق من وصول النشر");
    let healthy = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      update(id, `التحقق من وصول النشر (${attempt + 1}/15)`);
      const response = await cfTransport
        .fetch(`${url}/_edge/health`, {
          headers: { Authorization: `Bearer ${decryptSecret(c.edge_secret)}` },
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        })
        .catch(() => null);
      const health: any = await response?.json().catch(() => null);
      if (
        response?.ok &&
        health?.architecture === "worker-durable-object-linux" &&
        (kind !== "deploy" || health.release === `job-${id}`)
      ) {
        healthy = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!healthy)
      throw new Error(
        "تم إرسال النشر لكن فحص الوصول لم ينجح؛ راجع Cloudflare قبل إعادة المحاولة",
      );
    update(id, "نجحت العملية", { status: "succeeded", version, url });
  } catch (error) {
    // Only our own bounded messages are stored; no token/provider body is logged.
    const message =
      error instanceof Error &&
      /^(Cloudflare |اسم Worker|الإصدار |عنوان Linux|تم إرسال)/.test(
        error.message,
      )
        ? error.message
        : "تعذّرت العملية. تحقق من الشبكة وصلاحيات Token وDurable Objects وحالة الخدمة.";
    update(id, "فشلت العملية", { status: "failed", error: message });
  }
}
