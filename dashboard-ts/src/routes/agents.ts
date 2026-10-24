/** Signed-in model settings, managed runs, ownership and downloadable results. */
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar-stream";
import { all, getDb, one, run } from "../db";
import { getComputer, listComputers } from "../machines";
import { providerFor } from "../providers";
import { nowIso } from "../settings";
import { render } from "../templates";
import { requireToken } from "../security";
import {
  browserHost,
  fail,
  intParam,
  jsonBody,
  notFound,
  ok,
  type Env,
} from "../http";
import {
  encryptSecret,
  decryptSecret,
  hasExternalAction,
  event,
  models,
  modelById,
  owner,
  publicModel,
  runById,
} from "../agents/store";
import { artifactManifest } from "../agents/artifacts";
import { resultDir, scheduleRun, stopRun } from "../agents/runner";

import { pageView } from "../page-view";
export const agentRoutes = new Hono<Env>();
agentRoutes.get("/agents", (c) => pageView(c, "agents.html", "/agents"));
agentRoutes.get("/api/v1/agents/models", (c) =>
  ok(c, models().map(publicModel)),
);
agentRoutes.post("/api/v1/agents/models", requireToken, async (c) => {
  const body = await jsonBody(c);
  const name = String(body.name || "").trim(),
    model = String(body.model || "").trim();
  if (!name || name.length > 100 || !model || model.length > 200)
    return fail(
      c,
      "Model name and model ID are required (100/200 characters maximum)",
    );
  let url: URL;
  try {
    url = new URL(String(body.base_url || "https://api.openai.com/v1"));
  } catch {
    return fail(c, "Invalid API base URL");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return fail(
      c,
      "Use an HTTP(S) base URL without credentials, query or fragment",
    );
  if (!["responses", "chat"].includes(body.protocol))
    return fail(c, "Choose Responses or Chat Completions");
  const key = String(body.api_key || "");
  if (key.length > 4096) return fail(c, "API key is too long");
  const id = Number(body.id) || 0,
    existing = id ? modelById(id) : null;
  if (id && !existing) return notFound(c);
  const managedCli = String(body.managed_cli ?? existing?.managed_cli ?? "");
  if (!["", "claude", "codex"].includes(managedCli))
    return fail(c, "Invalid managed provider");
  if (managedCli && body.protocol !== "chat")
    return fail(c, "Managed CLI providers use Chat Completions");
  const secret = key ? encryptSecret(key) : existing?.secret || "";
  const values = [
    name,
    model,
    url.toString().replace(/\/$/, ""),
    body.protocol,
    body.vision === false ? 0 : 1,
    secret,
    managedCli,
  ];
  if (id)
    run(
      "UPDATE agent_models SET name=?,model=?,base_url=?,protocol=?,vision=?,secret=?,managed_cli=? WHERE id=?",
      ...values,
      id,
    );
  else
    run(
      "INSERT INTO agent_models(name,model,base_url,protocol,vision,secret,managed_cli) VALUES(?,?,?,?,?,?,?)",
      ...values,
    );
  c.set("auditDetail", `model configuration ${name}; credentials not recorded`);
  return ok(c, models().map(publicModel), id ? 200 : 201);
});
// Management is explicitly enabled per model; credentials only travel server-to-gateway.
for (const action of [
  "status",
  "test",
  "login",
  "login/complete",
  "login/cancel",
] as const) {
  const handler = async (c: any) => {
    const model = modelById(intParam(c, "id") || 0);
    if (!model) return notFound(c);
    c.header("Cache-Control", "no-store");
    if (!["claude", "codex"].includes(model.managed_cli || ""))
      return fail(
        c,
        "هذا الاتصال لا يدعم إدارة تسجيل الدخول. اختر خدمة Claude أو Codex المُدارة في إعدادات الاتصال.",
        400,
      );
    if (
      action.startsWith("login") &&
      one("SELECT id FROM agent_runs WHERE model_id=? AND lease=1", model.id)
    )
      return fail(c, "أوقف مهمة هذا الموديل قبل إعادة تسجيل الدخول.", 409);
    const base = new URL(model.base_url);
    base.pathname =
      base.pathname.replace(/\/v1\/?$/, "") + "/management/" + action;
    let body: any = undefined;
    if (action !== "status")
      body = action === "test" ? { model: model.model } : await jsonBody(c);
    try {
      const response = await fetch(base, {
        method: action === "status" ? "GET" : "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${decryptSecret(model.secret)}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 401 || response.status === 403)
        return fail(
          c,
          "مفتاح الاتصال بالخدمة مرفوض. حدّث مفتاح الخدمة في إعدادات الاتصال؛ إعادة دخول الحساب لن تصلح مفتاح البوابة.",
          424,
        );
      if (response.status === 404)
        return fail(
          c,
          "خدمة المزوّد قديمة ولا تدعم إدارة الاتصال. حدّث ملفات خدمة Claude أو Codex على السيرفر.",
          424,
        );
      const data: any = await response.json();
      if (!response.ok)
        return fail(
          c,
          typeof data.error === "string"
            ? data.error.slice(0, 500)
            : "تعذر تنفيذ العملية. أعد المحاولة.",
          response.status === 409 ? 409 : response.status === 400 ? 400 : 424,
        );
      // Do not accept a gateway that identifies as a different configured provider.
      if (data.provider && data.provider !== model.managed_cli)
        return fail(c, "نوع الخدمة لا يطابق إعداد الاتصال.", 424);
      return ok(c, data, response.status as any);
    } catch {
      return fail(
        c,
        "تعذر الوصول لخدمة المزوّد على السيرفر أو انتهت المهلة. تحقق من تشغيل الخدمة والشبكة ثم أعد المحاولة.",
        424,
      );
    }
  };
  if (action === "status")
    agentRoutes.get(`/api/v1/agents/models/:id/${action}`, handler);
  else
    agentRoutes.post(
      `/api/v1/agents/models/:id/${action}`,
      requireToken,
      handler,
    );
}
agentRoutes.delete("/api/v1/agents/models/:id", requireToken, (c) => {
  const id = intParam(c, "id");
  if (!id || !modelById(id)) return notFound(c);
  if (one("SELECT id FROM agent_runs WHERE model_id=? AND lease=1", id))
    return fail(c, "Stop active runs before deleting their model", 409);
  run("DELETE FROM agent_models WHERE id=?", id);
  return ok(c, { deleted: true });
});
agentRoutes.get("/api/v1/agents/runs", (c) =>
  ok(
    c,
    all(
      "SELECT r.*,c.name AS computer_name,m.name AS model_name FROM agent_runs r LEFT JOIN computers c ON c.id=r.computer_id LEFT JOIN agent_models m ON m.id=r.model_id ORDER BY r.id DESC LIMIT 100",
    ),
  ),
);
agentRoutes.post("/api/v1/agents/runs", requireToken, async (c) => {
  const body = await jsonBody(c),
    comp = getComputer(Number(body.computer_id)),
    model = modelById(Number(body.model_id));
  if (!comp || !model)
    return fail(c, "Choose an existing machine and configured model");
  if (comp.reserved)
    return fail(
      c,
      "This machine is reserved for manual control. Release it before starting an agent.",
      409,
    );
  const task = String(body.task || "").trim();
  if (!task || task.length > 20_000)
    return fail(c, "Write a task (maximum 20,000 characters)");
  const steps = Number(body.max_steps ?? 30),
    seconds = Number(body.max_seconds ?? 300);
  if (
    !Number.isInteger(steps) ||
    steps < 1 ||
    steps > 100 ||
    !Number.isInteger(seconds) ||
    seconds < 10 ||
    seconds > 900
  )
    return fail(c, "Limits must be 1–100 model turns and 10–900 seconds");
  let id: number;
  try {
    id = getDb().transaction(() => {
      if (owner(comp.id) || hasExternalAction(comp.id))
        throw new Error(
          "This machine already has an agent, a draining run or an in-flight external action",
        );
      return run(
        "INSERT INTO agent_runs(computer_id,model_id,task,status,max_steps,max_seconds,created_at,updated_at,actor) VALUES(?,?,?,'queued',?,?,?,?,?)",
        comp.id,
        model.id,
        task,
        steps,
        seconds,
        nowIso(),
        nowIso(),
        c.get("actor") || "dashboard",
      ).lastInsertRowid;
    })();
  } catch {
    return fail(
      c,
      "This machine already has an agent, a draining run or an in-flight external action",
      409,
    );
  }
  event(id, "queued", "Task accepted; exclusive machine control acquired");
  scheduleRun(id);
  c.set("auditTarget", comp.name);
  c.set("auditDetail", `agent run ${id}`);
  return ok(c, runById(id), 202);
});
agentRoutes.get("/api/v1/agents/runs/:id", (c) => {
  const id = intParam(c, "id"),
    job = id ? runById(id) : null;
  if (!job) return notFound(c);
  const comp = getComputer(job.computer_id);
  const viewer = comp
    ? providerFor(comp).novncUrl(
        comp.novnc_port,
        comp.vnc_password,
        browserHost(c),
      )
    : null;
  return ok(c, {
    ...job,
    manual_reserved: !!comp?.reserved,
    events: all(
      "SELECT id,kind,message,created_at FROM agent_events WHERE run_id=? ORDER BY id LIMIT 1000",
      job.id,
    ),
    artifacts: all(
      "SELECT id,name,bytes FROM agent_artifacts WHERE run_id=?",
      job.id,
    ),
    viewer_url: viewer ? viewer + (job.lease ? "&view_only=true" : "") : null,
  });
});
for (const action of ["stop", "takeover"] as const)
  agentRoutes.post(
    `/api/v1/agents/runs/:id/${action}`,
    requireToken,
    async (c) => {
      const id = intParam(c, "id");
      if (!id || !runById(id)) return notFound(c);
      try {
        return ok(c, await stopRun(id, action === "takeover"), 202);
      } catch (err: any) {
        return fail(c, err.message, 409);
      }
    },
  );
agentRoutes.get("/api/v1/agents/runs/:id/result", async (c) => {
  const id = intParam(c, "id"),
    job = id ? runById(id) : null;
  if (!job) return notFound(c);
  if (job.lease)
    return fail(
      c,
      "Wait until execution and any in-flight action have stopped",
      409,
    );
  const pack = tar.pack(),
    chunks: Buffer[] = [];
  const done = (async () => {
    for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  })();
  pack.entry(
    { name: "report.md" },
    Buffer.from(
      `# Run ${job.id}: ${job.status}\n\n${job.summary || job.error || "Stopped by user"}\n`,
    ),
  );
  pack.entry(
    { name: "activity.json" },
    Buffer.from(
      JSON.stringify(
        all(
          "SELECT kind,message,created_at FROM agent_events WHERE run_id=? ORDER BY id",
          job.id,
        ),
        null,
        2,
      ),
    ),
  );
  const files = all<{ id: number; name: string; disk_name: string }>(
    "SELECT id,name,disk_name FROM agent_artifacts WHERE run_id=?",
    job.id,
  ).map((file) => ({
    ...file,
    data: readFileSync(join(resultDir(job.id), file.disk_name)),
  }));
  for (const file of files)
    pack.entry({ name: `files/${file.id}-${file.name}` }, file.data);
  pack.entry(
    { name: "manifest.json" },
    JSON.stringify(artifactManifest(job, files), null, 2),
  );
  pack.finalize();
  await done;
  return c.body(gzipSync(Buffer.concat(chunks)), 200, {
    "content-type": "application/gzip",
    "content-disposition": `attachment; filename="deskswarm-run-${job.id}.tar.gz"`,
  });
});
