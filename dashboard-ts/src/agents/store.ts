/** Persistent models, runs and exclusive machine ownership. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { all, getDb, one, run } from "../db";
import { DB_PATH, nowIso } from "../settings";

export interface Model {
  id: number;
  name: string;
  model: string;
  base_url: string;
  protocol: "responses" | "chat";
  vision: number;
  secret: string;
}
export interface AgentRun {
  id: number;
  computer_id: number;
  model_id: number;
  task: string;
  status: string;
  lease: number;
  stop_reason: string | null;
  summary: string;
  error: string;
  steps: number;
  max_steps: number;
  max_seconds: number;
  created_at: string;
  updated_at: string;
  actor: string;
  drain_until: number;
}
export function initAgents() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS agent_models(id INTEGER PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL, base_url TEXT NOT NULL, protocol TEXT NOT NULL, vision INTEGER NOT NULL DEFAULT 1, secret TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS agent_runs(id INTEGER PRIMARY KEY, computer_id INTEGER NOT NULL, model_id INTEGER NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL, lease INTEGER NOT NULL DEFAULT 1, stop_reason TEXT, summary TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', steps INTEGER NOT NULL DEFAULT 0, max_steps INTEGER NOT NULL, max_seconds INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, actor TEXT NOT NULL, drain_until INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX IF NOT EXISTS agent_one_owner ON agent_runs(computer_id) WHERE lease=1;
    CREATE TABLE IF NOT EXISTS agent_events(id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_artifacts(id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, name TEXT NOT NULL, disk_name TEXT NOT NULL, bytes INTEGER NOT NULL);
  `);
}
function masterKey() {
  const path = join(
    dirname(process.env.DESKSWARM_DB_PATH || DB_PATH),
    ".agent-secret-key",
  );
  if (!existsSync(path)) {
    try {
      writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
    }
  }
  chmodSync(path, 0o600);
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error("Invalid agent secret key");
  return key;
}
export function encryptSecret(value: string) {
  if (!value) return "";
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}
export function decryptSecret(value: string) {
  if (!value) return "";
  const bytes = Buffer.from(value, "base64"),
    cipher = createDecipheriv(
      "aes-256-gcm",
      masterKey(),
      bytes.subarray(0, 12),
    );
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    cipher.update(bytes.subarray(28)),
    cipher.final(),
  ]).toString("utf8");
}
export const models = () =>
  all<Model>("SELECT * FROM agent_models ORDER BY id");
export const modelById = (id: number) =>
  one<Model>("SELECT * FROM agent_models WHERE id=?", id);
export const publicModel = ({ secret, ...model }: Model) => ({
  ...model,
  has_key: !!secret,
});
export const runById = (id: number) =>
  one<AgentRun>("SELECT * FROM agent_runs WHERE id=?", id);
export const owner = (computerId: number) =>
  one<AgentRun>(
    "SELECT * FROM agent_runs WHERE computer_id=? AND lease=1",
    computerId,
  );
export function event(runId: number, kind: string, message: string) {
  run(
    "INSERT INTO agent_events(run_id,kind,message,created_at) VALUES(?,?,?,?)",
    runId,
    kind,
    message.slice(0, 8000),
    nowIso(),
  );
}
export function recoverInterrupted() {
  run(
    "UPDATE agent_runs SET status='interrupted', error='Dashboard restarted. Execution was not replayed; take control to release this machine.', updated_at=?,drain_until=? WHERE lease=1",
    nowIso(),
    Date.now() + 65_000,
  );
}

// Bridge the synchronous lease claim with already-running external operations.
// One dashboard process owns these counts; restart recovery retains DB leases.
const externalActions = new Map<number, number>();
export const hasExternalAction = (computerId: number) =>
  (externalActions.get(computerId) || 0) > 0;
export function beginExternalAction(computerId: number) {
  externalActions.set(computerId, (externalActions.get(computerId) || 0) + 1);
  return () => {
    const count = (externalActions.get(computerId) || 1) - 1;
    if (count) externalActions.set(computerId, count);
    else externalActions.delete(computerId);
  };
}
