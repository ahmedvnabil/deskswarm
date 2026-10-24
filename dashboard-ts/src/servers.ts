/** SSH host registry. Keys are encrypted and host identities are pinned. */
import Docker from "dockerode";
import { Agent } from "node:http";
import { Client, utils, type ConnectConfig, type ClientChannel } from "ssh2";
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { all, getDb, one, run } from "./db";
import { encryptSecret, decryptSecret } from "./agents/store";
import { nowIso } from "./settings";

export interface ServerConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  fingerprint: string;
  private_key: string;
  passphrase: string;
}
export interface ServerRow {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  fingerprint: string;
  secret: string;
  status: string;
  checked_at: string;
  info: string;
}
export function initServers() {
  getDb().exec(`
 CREATE TABLE IF NOT EXISTS servers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,host TEXT NOT NULL,port INTEGER NOT NULL,username TEXT NOT NULL,fingerprint TEXT NOT NULL,secret TEXT NOT NULL,status TEXT NOT NULL,checked_at TEXT NOT NULL,info TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS server_address ON servers(host,port,username);
 CREATE TABLE IF NOT EXISTS server_tests(token_hash TEXT PRIMARY KEY,digest TEXT NOT NULL,expires_at INTEGER NOT NULL,info TEXT NOT NULL);
`);
}
export const serverById = (id: number) =>
  one<ServerRow>("SELECT * FROM servers WHERE id=?", id);
export const serverRows = () =>
  all<ServerRow>("SELECT * FROM servers ORDER BY id");
export const publicServer = ({ secret, ...row }: ServerRow) => ({
  ...row,
  provider: `server:${row.id}`,
  has_key: !!secret,
  info: JSON.parse(row.info),
});
export function validateServer(body: Record<string, any>): ServerConfig {
  const c = {
    name: String(body.name || "").trim(),
    host: String(body.host || "").trim(),
    port: Number(body.port ?? 22),
    username: String(body.username || "").trim(),
    fingerprint: String(body.fingerprint || "")
      .trim()
      .replace(/=$/, ""),
    private_key: String(body.private_key || ""),
    passphrase: String(body.passphrase || ""),
  };
  if (!c.name || c.name.length > 100)
    throw Error("اسم السيرفر مطلوب، بحد أقصى 100 حرف");
  if (
    !c.host ||
    c.host.length > 253 ||
    (!isIP(c.host) &&
      !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(c.host))
  )
    throw Error("أدخل عنوان IP أو اسم مضيف صحيحًا");
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
    throw Error("منفذ SSH غير صحيح");
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(c.username))
    throw Error("اسم مستخدم SSH غير صحيح");
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(c.fingerprint))
    throw Error("أدخل بصمة SSH صحيحة بصيغة SHA256 من السيرفر");
  if (
    !c.private_key ||
    c.private_key.length > 65536 ||
    c.passphrase.length > 4096
  )
    throw Error("اختر مفتاح SSH صالحًا بحجم لا يتجاوز 64 KB");
  const key = utils.parseKey(c.private_key, c.passphrase || undefined);
  if (key instanceof Error)
    throw Error("تعذّر قراءة مفتاح SSH؛ تحقق من الملف وعبارة المرور");
  return c;
}
export function sshOptions(c: ServerConfig): ConnectConfig {
  return {
    host: c.host,
    port: c.port,
    username: c.username,
    privateKey: c.private_key,
    passphrase: c.passphrase || undefined,
    readyTimeout: 10000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 2,
    hostVerifier: (key: Buffer) =>
      `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}` ===
      c.fingerprint,
  };
}
export function configFor(row: ServerRow): ServerConfig {
  return { ...row, ...JSON.parse(decryptSecret(row.secret)) };
}
/** SSH channels are Duplex streams; Node/Bun HTTP also expects Socket methods. */
export function channelSocket(stream: ClientChannel) {
  const socket = stream as any;
  if (socket.deskswarmSocket) return socket;
  socket.deskswarmSocket = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let milliseconds = 0;
  const reset = () => {
    if (timer) clearTimeout(timer);
    if (milliseconds)
      timer = setTimeout(() => stream.emit("timeout"), milliseconds);
  };
  socket.setTimeout = (ms: number, callback?: () => void) => {
    milliseconds = ms;
    if (callback) stream.once("timeout", callback);
    reset();
    return socket;
  };
  socket.setNoDelay = () => socket;
  socket.setKeepAlive = () => socket;
  socket.ref = () => socket;
  socket.unref = () => socket;
  socket.connecting = false;
  stream.on("data", reset);
  stream.once("close", () => {
    if (timer) clearTimeout(timer);
  });
  return socket;
}
function dockerChannel(c: ServerConfig): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    const ssh = new Client();
    const timer = setTimeout(() => {
      ssh.destroy();
      reject(Error("SSH Docker connection timeout"));
    }, 12000);
    ssh.on("error", (error: Error & {level?: string}) => {
      clearTimeout(timer);
      reject(Error(error.level === "client-authentication" ? "SSH authentication failed" : "SSH Docker connection failed"));
    });
    ssh.on("ready", () =>
      ssh.exec("docker system dial-stdio", (error, stream) => {
        clearTimeout(timer);
        if (error) {
          ssh.end();
          reject(Error("Docker access unavailable"));
          return;
        }
        stream.once("close", () => ssh.end());
        resolve(stream);
      }),
    );
    ssh.connect(sshOptions(c));
  });
}
export function remoteDocker(c: ServerConfig) {
  const agent = new Agent({ keepAlive: false, maxSockets: 8 });
  agent.createConnection = (_options: any, callback: any): any => {
    dockerChannel(c).then(
      (stream) => callback(null, channelSocket(stream)),
      (error) => callback(error),
    );
  };
  // The HTTP endpoint is a logical name. The custom agent exclusively opens
  // pinned SSH exec channels; it never connects to a TCP Docker API.
  return new Docker({
    host: "http://docker-via-ssh",
    port: 80,
    protocol: "http",
    timeout: 65000,
    agent,
  } as Docker.DockerOptions);
}
export const digest = (c: ServerConfig) =>
  createHash("sha256").update(JSON.stringify(c)).digest("hex");
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const connectionProbe = {
  async info(c: ServerConfig) {
    const info = await remoteDocker(c).info();
    if (info.OSType !== "linux") throw Error("Linux Docker is required");
    return {
      hostname: info.Name,
      version: info.ServerVersion,
      architecture: info.Architecture,
      cpus: info.NCPU,
      memory_mb: Math.floor(info.MemTotal / 1048576),
      containers: info.ContainersRunning,
    };
  },
};
export async function testServer(c: ServerConfig) {
  const info = await connectionProbe.info(c);
  const token = randomBytes(32).toString("hex");
  run("DELETE FROM server_tests WHERE expires_at<?", Date.now());
  run(
    "INSERT INTO server_tests VALUES(?,?,?,?)",
    tokenHash(token),
    digest(c),
    Date.now() + 300000,
    JSON.stringify(info),
  );
  return { test_token: token, info };
}
export function saveTestedServer(c: ServerConfig, token: string) {
  return getDb().transaction(() => {
    const test = one<{ digest: string; expires_at: number; info: string }>(
      "SELECT * FROM server_tests WHERE token_hash=?",
      tokenHash(token),
    );
    if (!test || test.expires_at < Date.now() || test.digest !== digest(c))
      throw Error(
        "اختبر نفس إعدادات الاتصال قبل الحفظ؛ صلاحية الاختبار خمس دقائق",
      );
    const id = run(
      "INSERT INTO servers(name,host,port,username,fingerprint,secret,status,checked_at,info) VALUES(?,?,?,?,?,?,'connected',?,?)",
      c.name,
      c.host,
      c.port,
      c.username,
      c.fingerprint,
      encryptSecret(
        JSON.stringify({
          private_key: c.private_key,
          passphrase: c.passphrase,
        }),
      ),
      nowIso(),
      test.info,
    ).lastInsertRowid;
    run("DELETE FROM server_tests WHERE token_hash=?", tokenHash(token));
    return publicServer(serverById(Number(id))!);
  })();
}
/** Fixed loopback destination; callers cannot request arbitrary SSH forwards. */
export function forwardScreen(
  row: ServerRow,
  port: number,
): Promise<{ stream: ClientChannel; close: () => void }> {
  return new Promise((resolve, reject) => {
    const ssh = new Client();
    const timer = setTimeout(() => {
      ssh.destroy();
      reject(Error("SSH screen timeout"));
    }, 12000);
    ssh.on("error", () => {
      clearTimeout(timer);
      reject(Error("SSH screen connection failed"));
    });
    ssh.on("ready", () =>
      ssh.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (error, stream) => {
        clearTimeout(timer);
        if (error) {
          ssh.end();
          reject(Error("Screen unavailable"));
          return;
        }
        stream.on("close", () => ssh.end());
        resolve({
          stream: channelSocket(stream),
          close: () => {
            stream.destroy();
            ssh.end();
          },
        });
      }),
    );
    ssh.connect(sshOptions(configFor(row)));
  });
}
