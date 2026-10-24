import { randomBytes, createHash } from "node:crypto";
import { isIP } from "node:net";
import { all, one, run, getDb } from "../db";
import { encryptSecret, decryptSecret } from "../agents/store";
import { nowIso } from "../settings";
import { serverRows, validateServer, testServer, saveTestedServer, connectionProbe, configFor, type ServerConfig } from "../servers";
export function initConnections() {
  getDb()
    .exec(`CREATE TABLE IF NOT EXISTS netbird_connection(id INTEGER PRIMARY KEY CHECK(id=1),base_url TEXT NOT NULL,secret TEXT NOT NULL,checked_at TEXT NOT NULL,error TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS netbird_diagnostics(peer_id TEXT PRIMARY KEY,code TEXT NOT NULL,username TEXT NOT NULL,checked_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS netbird_retry_profiles(peer_id TEXT NOT NULL,username TEXT NOT NULL,host TEXT NOT NULL,secret TEXT NOT NULL,PRIMARY KEY(peer_id,username));
  CREATE TABLE IF NOT EXISTS netbird_ssh_checks(peer_id TEXT PRIMARY KEY,checked_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS netbird_peers(id TEXT PRIMARY KEY,name TEXT NOT NULL,ip TEXT NOT NULL,dns_label TEXT NOT NULL,os TEXT NOT NULL,connected INTEGER NOT NULL,last_seen TEXT NOT NULL,synced_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS connection_preferences(id INTEGER PRIMARY KEY CHECK(id=1),ssh_user TEXT NOT NULL,ssh_port INTEGER NOT NULL);`);
}
export const netbirdTransport = {
  fetch: (url: string, init?: RequestInit) => fetch(url, init),
};
const connection = () => one("SELECT * FROM netbird_connection WHERE id=1");
export function preferences() {
  return (
    one("SELECT ssh_user,ssh_port FROM connection_preferences WHERE id=1") || {
      ssh_user: "ubuntu",
      ssh_port: 22,
    }
  );
}
export function savePreferences(body: Record<string, any>) {
  const user = String(body.ssh_user || "").trim(),
    port = Number(body.ssh_port);
  if (
    !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(user) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw Error("اسم مستخدم SSH أو المنفذ غير صالح");
  run(
    "INSERT OR REPLACE INTO connection_preferences VALUES(1,?,?)",
    user,
    port,
  );
  return preferences();
}
export function status() {
  const c = connection();
  return c
    ? {
        base_url: c.base_url,
        has_token: true,
        checked_at: c.checked_at,
        error: c.error,
        peer_count: one("SELECT COUNT(*) n FROM netbird_peers")!.n,
      }
    : null;
}
function normalize(body: Record<string, any>) {
  const url = new URL(String(body.base_url || "https://api.netbird.io"));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("أدخل عنوان HTTPS صحيحًا لإدارة NetBird");
  const base_url = url.href.replace(/\/+$/, "");
  const c = connection();
  const token =
    String(body.token || "").trim() ||
    (c?.base_url === base_url ? decryptSecret(c.secret) : "");
  if (!token || token.length > 4096 || /\s/.test(token))
    throw Error("أدخل NetBird Personal Access Token");
  return { base_url, token };
}
async function fetchPeers(c: ReturnType<typeof normalize>) {
  const url = c.base_url.endsWith("/api")
    ? `${c.base_url}/peers`
    : `${c.base_url}/api/peers`;
  const response = await netbirdTransport.fetch(url, {
    headers: { Authorization: `Token ${c.token}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error(
      `تعذّر اتصال NetBird (HTTP ${response.status})؛ تحقق من PAT وصلاحية قراءة الأجهزة`,
    );
  if (Number(response.headers.get("content-length") || 0) > 5 * 1024 * 1024)
    throw Error("استجابة NetBird أكبر من الحد المسموح");
  const reader = response.body?.getReader();
  if (!reader) throw Error("صيغة أجهزة NetBird غير مدعومة");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 5 * 1024 * 1024) {
        await reader.cancel();
        throw Error("استجابة NetBird أكبر من الحد المسموح");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(data) || data.length > 10000)
    throw Error("صيغة أجهزة NetBird غير مدعومة");
  return data.map((p: any) => {
    if (!p || typeof p.id !== "string" || !p.id || p.id.length > 200)
      throw Error("صيغة جهاز NetBird غير صالحة");
    return {
      id: p.id,
      name: String(p.name || p.id).slice(0, 200),
      ip: isIP(String(p.ip || "")) ? String(p.ip) : "",
      dns_label: String(p.dns_label || "").slice(0, 253),
      os: String(p.os || "").slice(0, 100),
      connected: p.connected === true,
      last_seen:
        typeof p.last_seen === "string" &&
        Number.isFinite(Date.parse(p.last_seen))
          ? p.last_seen
          : "",
    };
  });
}
const tickets = new Map<string, { digest: string; expires: number }>();
const hash = (c: unknown) =>
  createHash("sha256").update(JSON.stringify(c)).digest("hex");
export async function testConnection(body: Record<string, any>) {
  const c = normalize(body),
    peers = await fetchPeers(c),
    ticket = randomBytes(32).toString("hex");
  for (const [k, v] of tickets) if (v.expires < Date.now()) tickets.delete(k);
  if (tickets.size > 100) tickets.clear();
  tickets.set(ticket, { digest: hash(c), expires: Date.now() + 300000 });
  return { test_token: ticket, peer_count: peers.length };
}
function cache(peers: Awaited<ReturnType<typeof fetchPeers>>) {
  getDb().transaction(() => {
    run("DELETE FROM netbird_peers");
    for (const p of peers)
      run(
        "INSERT INTO netbird_peers VALUES(?,?,?,?,?,?,?,?)",
        p.id,
        p.name,
        p.ip,
        p.dns_label,
        p.os,
        p.connected ? 1 : 0,
        p.last_seen,
        nowIso(),
      );
    run(
      "UPDATE netbird_connection SET checked_at=?,error='' WHERE id=1",
      nowIso(),
    );
  })();
}
export async function save(body: Record<string, any>) {
  const c = normalize(body),
    ticket = String(body.test_token || ""),
    checked = tickets.get(ticket);
  tickets.delete(ticket);
  if (!checked || checked.expires < Date.now() || checked.digest !== hash(c))
    throw Error("اختبر نفس بيانات NetBird أولًا");
  // Re-fetch before switching account, preserving the previous inventory on failure.
  const peers = await fetchPeers(c);
  getDb().transaction(() => {
    const previous = connection();
    if (previous && (previous.base_url !== c.base_url || decryptSecret(previous.secret) !== c.token)) {
      run("DELETE FROM netbird_retry_profiles");
      run("DELETE FROM netbird_diagnostics");
      run("DELETE FROM netbird_ssh_checks");
    }
    run(
      "INSERT OR REPLACE INTO netbird_connection VALUES(1,?,?,?,'')",
      c.base_url,
      encryptSecret(c.token),
      nowIso(),
    );
    cache(peers);
  })();
  return status();
}
export async function sync() {
  const row = connection();
  if (!row) throw Error("اربط NetBird أولًا");
  try {
    cache(
      await fetchPeers({
        base_url: row.base_url,
        token: decryptSecret(row.secret),
      }),
    );
    return status();
  } catch {
    run(
      "UPDATE netbird_connection SET error='فشلت المزامنة؛ المعروض آخر بيانات محفوظة وليس حالة مباشرة' WHERE id=1",
    );
    throw Error("تعذّرت مزامنة NetBird؛ آخر قائمة محفوظة ما زالت متاحة");
  }
}
export function peers() {
  const servers = serverRows();
  return all("SELECT * FROM netbird_peers ORDER BY connected DESC,name").map(
    (p) => {
      const server = servers.find(
        (s) => s.host === p.ip || (!!p.dns_label && s.host === p.dns_label),
      );
      const linux = /linux|ubuntu|debian|fedora|centos|rocky|alma|alpine|arch|suse|rhel|red hat|raspbian|raspberry pi os/i.test(p.os);
      const diagnostic = one("SELECT * FROM netbird_diagnostics WHERE peer_id=?", p.id);
      return {
        ...p,
        connected: !!p.connected,
        server_id: server?.id || null,
        server_status: server?.status || null,
        server_checked_at: server?.checked_at || null,
        readiness: server ? "configured" : "unconfigured",
        linux,
        connectable: !!p.ip && linux,
        retry_available: !!server || !!one("SELECT peer_id FROM netbird_retry_profiles WHERE peer_id=? AND host IN (?,?)", p.id, p.ip, p.dns_label),
        netbird_ssh: one("SELECT checked_at FROM netbird_ssh_checks WHERE peer_id=?", p.id),
        diagnostic: diagnostic ? {code: diagnostic.code, username: diagnostic.username, checked_at: diagnostic.checked_at, message: diagnosticMessages[diagnostic.code as keyof typeof diagnosticMessages]} : null,
      };
    },
  );
}

const diagnosticMessages = {
  netbird_ssh_unavailable: "NetBird SSH غير متاح على الجهاز؛ يلزم تفعيل خادم SSH وسياسة الوصول المتوافقة في NetBird",
  connection_failed: "فشل اختبار SSH أو Docker؛ تحقق من المفتاح والبصمة والشبكة وصلاحيات Docker",
  offline: "الجهاز غير متصل بنفق NetBird موثّق؛ تحقق من تشغيل العميل وسياسة الشبكة",
  unreachable: "تعذّر الوصول إلى SSH أو جلب بصمته؛ تحقق من المنفذ وسياسة الشبكة",
  auth_failed: "رفض SSH المفتاح للمستخدمين الذين جرت تجربتهم؛ أضف المفتاح العام أو صحّح اسم المستخدم",
  docker_missing: "نجح SSH لكن Docker غير مثبت",
  docker_failed: "نجح SSH لكن فحص Docker فشل؛ تحقق من تشغيل الخدمة وصلاحيات المستخدم",
};
export function rememberRetryConfig(config: ServerConfig) {
  if (serverRows().some(s => s.host === config.host)) return;
  const peer = one("SELECT id FROM netbird_peers WHERE ip=? OR dns_label=?", config.host, config.host);
  if (!peer) return;
  run("INSERT OR REPLACE INTO netbird_retry_profiles VALUES(?,?,?,?)", peer.id, config.username, config.host, encryptSecret(JSON.stringify(config)));
}
export function clearRetryConfig(host: string) {
  run("DELETE FROM netbird_retry_profiles WHERE host=?", host);
}
const retrying = new Set<string>();
export async function retryPeer(peerId: string) {
  if (retrying.has(peerId)) throw Error("إعادة المحاولة جارية بالفعل");
  const peer = one("SELECT * FROM netbird_peers WHERE id=?", peerId);
  if (!peer) throw Error("الجهاز غير موجود");
  retrying.add(peerId);
  try {
    const server = serverRows().find(s => s.host === peer.ip || (!!peer.dns_label && s.host === peer.dns_label));
    if (server) {
      try {
        const info = await connectionProbe.info(configFor(server));
        run("UPDATE servers SET status='connected',checked_at=?,info=? WHERE id=?", nowIso(), JSON.stringify(info), server.id);
        run("DELETE FROM netbird_diagnostics WHERE peer_id=?", peerId);
        return {server_id: server.id};
      } catch (error) {
        recordHostFailure(server.host, server.username, error);
        run("UPDATE servers SET status='unreachable',checked_at=? WHERE id=?", nowIso(), server.id);
        throw Error("فشل الاتصال؛ راجع التشخيص وحدّث بيانات SSH إذا لزم");
      }
    }
    const profiles = all("SELECT * FROM netbird_retry_profiles WHERE peer_id=? AND host IN (?,?) ORDER BY username", peerId, peer.ip, peer.dns_label);
    if (!profiles.length) throw Error("جهّز بيانات SSH أولًا لتفعيل إعادة المحاولة");
    for (const profile of profiles) {
      const config = validateServer(JSON.parse(decryptSecret(profile.secret)));
      try {
        const tested = await testServer(config);
        const saved = saveTestedServer(config, tested.test_token);
        run("DELETE FROM netbird_retry_profiles WHERE peer_id=?", peerId);
        run("DELETE FROM netbird_diagnostics WHERE peer_id=?", peerId);
        return {server_id: saved.id};
      } catch (error) { recordHostFailure(config.host, config.username, error); }
    }
    throw Error("فشلت إعادة المحاولة ببيانات SSH المحفوظة؛ راجع التشخيص");
  } finally { retrying.delete(peerId); }
}
export function recordHostFailure(host: string, username: string, error: unknown) {
  const peer = one("SELECT id FROM netbird_peers WHERE ip=? OR dns_label=?", host, host);
  if (!peer) return;
  const message = error instanceof Error ? error.message : "";
  const code = /authentication|Permission denied|All configured authentication/i.test(message) ? "auth_failed" : "connection_failed";
  recordDiagnostic(peer.id, {code, username});
}
export function recordDiagnostic(peerId: string, body: Record<string, any>) {
  if (!one("SELECT id FROM netbird_peers WHERE id=?", peerId)) throw Error("الجهاز غير موجود");
  const code = String(body.code || ""), username = String(body.username || "");
  if (!Object.hasOwn(diagnosticMessages, code) || (username && !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(username))) throw Error("تشخيص غير صالح");
  if (code === "netbird_ssh_unavailable") {
    run("INSERT OR REPLACE INTO netbird_ssh_checks VALUES(?,?)", peerId, nowIso());
    return {saved: true};
  }
  run("INSERT OR REPLACE INTO netbird_diagnostics VALUES(?,?,?,?)", peerId, code, username, nowIso());
  return {saved: true};
}
