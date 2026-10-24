import { randomBytes, createHash } from "node:crypto";
import { all, one, run, getDb } from "../db";
import { encryptSecret, decryptSecret } from "../agents/store";
import { nowIso } from "../settings";
import {
  accountInput,
  requestCF,
  cfTransport,
  config,
  execute,
} from "./control";
import { tunnelHost } from "./tunnel-host";

export function initTunnels() {
  getDb().exec(
    `CREATE TABLE IF NOT EXISTS cloudflare_tunnels(id INTEGER PRIMARY KEY AUTOINCREMENT,account TEXT NOT NULL,worker TEXT NOT NULL,hostname TEXT NOT NULL,zone TEXT NOT NULL,server_id INTEGER NOT NULL,backend TEXT NOT NULL,network TEXT NOT NULL,port INTEGER NOT NULL,resource_name TEXT NOT NULL,secret TEXT NOT NULL,tunnel_id TEXT NOT NULL DEFAULT '',dns_id TEXT NOT NULL DEFAULT '',container_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',error TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL,UNIQUE(account,hostname));`,
  );
}
export function publicTunnels() {
  return all(
    "SELECT id,account,worker,hostname,zone,server_id,backend,tunnel_id,status,error,updated_at FROM cloudflare_tunnels ORDER BY id DESC",
  );
}
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
export async function zones(body: Record<string, any>) {
  const c = accountInput(body);
  const found = await requestCF(
    c,
    `zones?account.id=${c.account}&status=active&per_page=50`,
  );
  return (found || []).map((z: any) => ({ id: z.id, name: z.name }));
}
export async function accounts(token: string) {
  if (!token && config()) token = decryptSecret(config()!.secret);
  if (!token || token.length > 4096 || /\s/.test(token))
    throw Error("أدخل API Token أولًا");
  const found = await requestCF({ token }, "accounts?per_page=50");
  return (found || []).map((a: any) => ({ id: a.id, name: a.name }));
}
function normalize(body: Record<string, any>) {
  let credentials = body;
  // A persisted, exact setup can resume after restart without retyping its key.
  // Never reuse this key for a changed host, service, Worker or account.
  if (!String(body.token || "").trim() && config()?.account !== body.account) {
    const saved = one(
      "SELECT secret FROM cloudflare_tunnels WHERE account=? AND hostname=? AND worker=? AND zone=? AND server_id=? AND backend=?",
      String(body.account || ""),
      String(body.hostname || "")
        .trim()
        .toLowerCase(),
      String(body.worker || ""),
      String(body.zone || ""),
      Number(body.server_id),
      String(body.backend || ""),
    );
    if (saved) credentials = { ...body, token: decryptSecret(saved.secret) };
  }
  const c = accountInput(credentials);
  const worker = String(body.worker || config()?.worker || "").trim();
  const hostname = String(body.hostname || "")
    .trim()
    .toLowerCase();
  const zone = String(body.zone || "").trim();
  const server_id = Number(body.server_id),
    backend = String(body.backend || "");
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(worker))
    throw Error("اسم Worker غير صالح");
  if (!/^[a-f0-9]{32}$/.test(zone)) throw Error("اختر الدومين من القائمة");
  if (
    hostname.length > 253 ||
    !hostname.includes(".") ||
    !hostname
      .split(".")
      .every((p) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))
  )
    throw Error("أدخل اسم نطاق فرعي صالحًا");
  if (
    !Number.isInteger(server_id) ||
    server_id < 0 ||
    !/^[a-f0-9]{12,64}$/.test(backend)
  )
    throw Error("اختر السيرفر وخدمة DeskSwarm المكتشفة");
  return {
    ...c,
    worker,
    hostname,
    zone,
    server_id,
    backend,
    deploy: body.deploy === true,
  };
}
const tickets = new Map<string, { digest: string; expires: number }>();
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function prepare(body: Record<string, any>) {
  const c = normalize(body);
  const zone = await requestCF(c, `zones/${c.zone}`);
  if (
    zone.account?.id !== c.account ||
    zone.status !== "active" ||
    !c.hostname.endsWith(`.${zone.name}`)
  )
    throw Error("اختر نطاقًا فرعيًا تابعًا للدومين النشط في نفس الحساب");
  const subdomain = await requestCF(
    c,
    `accounts/${c.account}/workers/subdomain`,
  );
  if (!subdomain?.subdomain)
    throw Error("فعّل workers.dev في حساب Cloudflare أولًا");
  await requestCF(
    c,
    `accounts/${c.account}/cfd_tunnel?is_deleted=false&per_page=1`,
  );
  const records = await requestCF(
    c,
    `zones/${c.zone}/dns_records?name=${c.hostname}&per_page=100`,
  );
  const previous = one(
    "SELECT * FROM cloudflare_tunnels WHERE account=? AND hostname=?",
    c.account,
    c.hostname,
  );
  if (
    records.length &&
    (!previous?.tunnel_id ||
      records.some(
        (r: any) =>
          r.type !== "CNAME" ||
          r.content !== `${previous.tunnel_id}.cfargotunnel.com`,
      ))
  )
    throw Error("النطاق الفرعي مستخدم بالفعل؛ لن نستبدل سجلات DNS الموجودة");
  if (
    previous &&
    (previous.server_id !== c.server_id ||
      previous.backend !== c.backend ||
      previous.zone !== c.zone ||
      previous.worker !== c.worker)
  )
    throw Error("هذا النطاق مربوط بإعدادات أخرى؛ استخدم نطاقًا فرعيًا جديدًا");
  await tunnelHost.probe(c.server_id, c.backend);
  const ticket = randomBytes(32).toString("hex");
  for (const [key, value] of tickets)
    if (value.expires < Date.now()) tickets.delete(key);
  if (tickets.size > 100) tickets.clear();
  tickets.set(ticket, { digest: hash(c), expires: Date.now() + 300000 });
  return {
    test_token: ticket,
    origin: `https://${c.hostname}`,
    message:
      "الحساب والدومين وخدمة Linux متاحون. سيتم إنشاء Tunnel وDNS وتشغيل connector عند الضغط على الربط؛ صلاحيات الكتابة تُفحص وقت الإنشاء.",
  };
}
function stage(job: number, text: string) {
  run(
    "UPDATE cloudflare_jobs SET stage=?,updated_at=? WHERE id=?",
    text,
    nowIso(),
    job,
  );
}
export function start(body: Record<string, any>) {
  const c = normalize(body),
    ticket = String(body.test_token || ""),
    checked = tickets.get(ticket);
  tickets.delete(ticket);
  if (!checked || checked.expires < Date.now() || checked.digest !== hash(c))
    throw Error("اختبر نفس إعدادات النفق أولًا");
  if (one("SELECT id FROM cloudflare_jobs WHERE status='running'"))
    throw Error("انتظر انتهاء العملية الجارية");
  // Register intent before external writes; persisted IDs permit recovery of partial provisioning.
  let row = one(
    "SELECT * FROM cloudflare_tunnels WHERE account=? AND hostname=?",
    c.account,
    c.hostname,
  );
  if (
    row &&
    (row.server_id !== c.server_id ||
      row.backend !== c.backend ||
      row.zone !== c.zone ||
      row.worker !== c.worker)
  )
    throw Error("إعدادات النفق الموجود مختلفة");
  if (!row) {
    const id = run(
      "INSERT INTO cloudflare_tunnels(account,worker,hostname,zone,server_id,backend,network,port,resource_name,secret,updated_at) VALUES(?,?,?,?,?,?,'',0,?,?,?)",
      c.account,
      c.worker,
      c.hostname,
      c.zone,
      c.server_id,
      c.backend,
      `deskswarm-${randomBytes(16).toString("hex")}`,
      encryptSecret(c.token),
      nowIso(),
    ).lastInsertRowid;
    row = one("SELECT * FROM cloudflare_tunnels WHERE id=?", id);
  } else
    run(
      "UPDATE cloudflare_tunnels SET secret=? WHERE id=?",
      encryptSecret(c.token),
      row.id,
    );
  const job = run(
    "INSERT INTO cloudflare_jobs(kind,status,stage,created_at,updated_at) VALUES('tunnel','running','التحقق من خدمة Linux',?,?)",
    nowIso(),
    nowIso(),
  ).lastInsertRowid;
  run(
    "UPDATE cloudflare_tunnels SET status='provisioning',error='',updated_at=? WHERE id=?",
    nowIso(),
    row!.id,
  );
  void provision(job, row!.id, c).catch(() => {});
  return { id: job, tunnel_id: row!.id };
}
async function provision(
  job: number,
  id: number,
  c: ReturnType<typeof normalize>,
) {
  try {
    let row = one("SELECT * FROM cloudflare_tunnels WHERE id=?", id)!;
    const target = await tunnelHost.probe(c.server_id, c.backend);
    run(
      "UPDATE cloudflare_tunnels SET network=?,port=? WHERE id=?",
      target.network,
      target.port,
      id,
    );
    stage(job, "إنشاء Tunnel المُدار من Cloudflare");
    if (!row.tunnel_id) {
      // A timed-out create can still have succeeded. Recover by our random stable name.
      const found = await requestCF(
        c,
        `accounts/${c.account}/cfd_tunnel?name=${row.resource_name}&is_deleted=false`,
      );
      const tunnel =
        found?.find((t: any) => t.name === row.resource_name) ||
        (await requestCF(
          c,
          `accounts/${c.account}/cfd_tunnel`,
          json({ name: row.resource_name, config_src: "cloudflare" }),
        ));
      if (!/^[a-f0-9-]{36}$/.test(tunnel.id))
        throw Error("Cloudflare لم يرجع هوية Tunnel صالحة");
      run(
        "UPDATE cloudflare_tunnels SET tunnel_id=? WHERE id=?",
        tunnel.id,
        id,
      );
      row = one("SELECT * FROM cloudflare_tunnels WHERE id=?", id)!;
    }
    stage(job, "ربط النفق بخدمة DeskSwarm");
    await requestCF(
      c,
      `accounts/${c.account}/cfd_tunnel/${row.tunnel_id}/configurations`,
      {
        ...json({
          config: {
            ingress: [
              {
                hostname: c.hostname,
                service: `http://${target.name}:${target.port}`,
              },
              { service: "http_status:404" },
            ],
          },
        }),
        method: "PUT",
      },
    );
    stage(job, "إنشاء سجل DNS دون تغيير السجلات الموجودة");
    const records = await requestCF(
      c,
      `zones/${c.zone}/dns_records?name=${c.hostname}&per_page=100`,
    );
    if (
      records.some(
        (r: any) =>
          r.type !== "CNAME" ||
          r.content !== `${row.tunnel_id}.cfargotunnel.com`,
      )
    )
      throw Error("النطاق الفرعي مستخدم بالفعل؛ لن نستبدل DNS");
    const dns =
      records[0] ||
      (await requestCF(
        c,
        `zones/${c.zone}/dns_records`,
        json({
          type: "CNAME",
          name: c.hostname,
          content: `${row.tunnel_id}.cfargotunnel.com`,
          proxied: true,
          ttl: 1,
        }),
      ));
    run("UPDATE cloudflare_tunnels SET dns_id=? WHERE id=?", dns.id, id);
    const token = await requestCF(
      c,
      `accounts/${c.account}/cfd_tunnel/${row.tunnel_id}/token`,
    );
    if (typeof token !== "string" || !token || token.length > 8192)
      throw Error("Cloudflare لم يرجع رمز تشغيل النفق");
    stage(job, "تشغيل cloudflared على سيرفر Linux");
    const container = await tunnelHost.start(c.server_id, {
      id,
      tunnel_id: row.tunnel_id,
      backend: c.backend,
      network: target.network,
      token,
    });
    run(
      "UPDATE cloudflare_tunnels SET container_id=? WHERE id=?",
      container,
      id,
    );
    const origin = `https://${c.hostname}`;
    let healthy = false;
    for (let i = 0; i < 20; i++) {
      stage(job, `انتظار اتصال Tunnel والتحقق من HTTPS (${i + 1}/20)`);
      const response = await cfTransport
        .fetch(`${origin}/health`, {
          signal: AbortSignal.timeout(8000),
          redirect: "error",
        })
        .catch(() => null);
      const health: any = await response?.json().catch(() => null);
      if (response?.ok && health?.status === "ok") {
        healthy = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!healthy)
      throw Error(
        "النفق لم يجتز فحص HTTPS بعد؛ تحقق من DNS وخروج السيرفر على المنفذ 7844 ثم أعد الاختبار والمحاولة",
      );
    const previous = config();
    run(
      "INSERT OR REPLACE INTO cloudflare_config VALUES(1,?,?,?,?,?,?)",
      c.account,
      c.worker,
      origin,
      encryptSecret(c.token),
      previous?.edge_secret || encryptSecret(randomBytes(32).toString("hex")),
      nowIso(),
    );
    run(
      "UPDATE cloudflare_tunnels SET status='ready',updated_at=? WHERE id=?",
      nowIso(),
      id,
    );
    if (c.deploy) {
      stage(job, "النفق جاهز؛ نشر Worker وDurable Objects");
      await execute(job, config(), "deploy");
    } else
      run(
        "UPDATE cloudflare_jobs SET status='succeeded',stage='النفق جاهز؛ يمكنك نشر التطبيق',url=?,updated_at=? WHERE id=?",
        origin,
        nowIso(),
        job,
      );
  } catch (e) {
    const error =
      e instanceof Error &&
      /^(Cloudflare |النطاق |النفق |اختر |خدمة |اسم |السيرفر)/.test(e.message)
        ? e.message
        : "تعذّر تجهيز النفق. تحقق من SSH وDocker وصلاحيات Tunnel وDNS؛ الموارد الجزئية محفوظة لإعادة المحاولة.";
    run(
      "UPDATE cloudflare_tunnels SET status='failed',error=?,updated_at=? WHERE id=?",
      error,
      nowIso(),
      id,
    );
    run(
      "UPDATE cloudflare_jobs SET status='failed',stage='تعذّر إعداد Tunnel؛ يمكن إعادة المحاولة',error=?,updated_at=? WHERE id=?",
      error,
      nowIso(),
      job,
    );
  }
}
export async function stop(id: number) {
  if (one("SELECT id FROM cloudflare_jobs WHERE status='running'"))
    throw Error("انتظر العملية الجارية أولًا");
  const row = one("SELECT * FROM cloudflare_tunnels WHERE id=?", id);
  if (!row) throw Error("النفق غير موجود");
  const job = run(
    "INSERT INTO cloudflare_jobs(kind,status,stage,created_at,updated_at) VALUES('tunnel-stop','running','إيقاف connector',?,?)",
    nowIso(),
    nowIso(),
  ).lastInsertRowid;
  try {
    await tunnelHost.stop(row.server_id, id, row.tunnel_id);
    run(
      "UPDATE cloudflare_tunnels SET status='stopped',updated_at=? WHERE id=?",
      nowIso(),
      id,
    );
    run(
      "UPDATE cloudflare_jobs SET status='succeeded',stage='النفق متوقف؛ يمكن إعادة تشغيله',updated_at=? WHERE id=?",
      nowIso(),
      job,
    );
    return { stopped: true };
  } catch {
    run(
      "UPDATE cloudflare_jobs SET status='failed',stage='تعذّر إيقاف النفق',updated_at=? WHERE id=?",
      nowIso(),
      job,
    );
    throw Error("تعذّر إيقاف النفق");
  }
}

/** Explicit readiness check; never mistake a saved configuration for a live tunnel. */
export async function check(id: number) {
  if (one("SELECT id FROM cloudflare_jobs WHERE status='running'"))
    throw Error("انتظر العملية الجارية");
  const row = one("SELECT * FROM cloudflare_tunnels WHERE id=?", id);
  if (!row) throw Error("النفق غير موجود");
  const job = run(
    "INSERT INTO cloudflare_jobs(kind,status,stage,created_at,updated_at) VALUES('tunnel-check','running','فحص HTTPS للنفق',?,?)",
    nowIso(),
    nowIso(),
  ).lastInsertRowid;
  let healthy = false;
  try {
    const response = await cfTransport.fetch(`https://${row.hostname}/health`, {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    const data: any = await response.json().catch(() => null);
    healthy = response.ok && data?.status === "ok";
  } catch {}
  run(
    "UPDATE cloudflare_tunnels SET status=?,error=?,updated_at=? WHERE id=?",
    healthy ? "ready" : "unreachable",
    healthy ? "" : "تعذّر الوصول عبر HTTPS؛ افحص connector وDNS والشبكة",
    nowIso(),
    id,
  );
  run(
    "UPDATE cloudflare_jobs SET status=?,stage=?,updated_at=? WHERE id=?",
    healthy ? "succeeded" : "failed",
    healthy ? "النفق متاح عبر HTTPS" : "النفق غير متاح عبر HTTPS",
    nowIso(),
    job,
  );
  return { healthy };
}
