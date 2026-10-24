import { Hono } from "hono";
import { all, one, run } from "../db";
import { serverBusy } from "../providers/docker-engine";
import {
  serverRows,
  publicServer,
  serverById,
  validateServer,
  testServer,
  saveTestedServer,
  connectionProbe,
  configFor,
} from "../servers";
import { requireToken } from "../security";
import { nowIso } from "../settings";
import { fail, intParam, jsonBody, notFound, ok, type Env } from "../http";
export const serverRoutes = new Hono<Env>();
serverRoutes.get("/api/v1/servers", (c) =>
  ok(c, [
    {
      id: 0,
      name: "Local",
      host: "هذا الجهاز",
      provider: "docker",
      status: "local",
      has_key: false,
    },
    ...serverRows().map(publicServer),
  ]),
);
serverRoutes.post("/api/v1/servers/test", requireToken, async (c) => {
  try {
    const config = validateServer(await jsonBody(c));
    c.set("auditDetail", "SSH connection test; credentials omitted");
    return ok(c, await testServer(config));
  } catch (error: any) {
    return fail(
      c,
      error?.message?.startsWith("أ") ||
        error?.message?.startsWith("ا") ||
        error?.message?.startsWith("ت")
        ? error.message
        : "تعذّر اتصال SSH أو الوصول إلى Docker. تحقق من العنوان والمفتاح والبصمة وصلاحيات Docker.",
      400,
    );
  }
});
serverRoutes.post("/api/v1/servers", requireToken, async (c) => {
  try {
    const body = await jsonBody(c),
      config = validateServer(body);
    const result = saveTestedServer(config, String(body.test_token || ""));
    c.set(
      "auditDetail",
      `SSH server connected: ${config.name}; credentials omitted`,
    );
    return ok(c, result, 201);
  } catch (error: any) {
    return fail(
      c,
      String(error?.message || "Could not save server").includes("UNIQUE")
        ? "هذا الاتصال موجود بالفعل"
        : String(error?.message || "Could not save server"),
      400,
    );
  }
});
serverRoutes.post("/api/v1/servers/:id/test", requireToken, async (c) => {
  const id = intParam(c, "id"),
    row = id ? serverById(id) : null;
  if (!row) return notFound(c);
  try {
    const info = await connectionProbe.info(configFor(row));
    run(
      "UPDATE servers SET status='connected',checked_at=?,info=? WHERE id=?",
      nowIso(),
      JSON.stringify(info),
      id,
    );
    return ok(c, publicServer(serverById(id!)!));
  } catch {
    run(
      "UPDATE servers SET status='unreachable',checked_at=? WHERE id=?",
      nowIso(),
      id,
    );
    return fail(
      c,
      "تعذّر الوصول إلى السيرفر. تحقق من SSH وDocker والبصمة.",
      502,
    );
  }
});
serverRoutes.delete("/api/v1/servers/:id", requireToken, (c) => {
  const id = intParam(c, "id");
  if (!id || !serverById(id)) return notFound(c);
  if (
    serverBusy(id) ||
    one("SELECT id FROM computers WHERE provider=?", `server:${id}`) ||
    one("SELECT id FROM snapshots WHERE provider=?", `server:${id}`)
  )
    return fail(
      c,
      "احذف الأجهزة واللقطات التابعة لهذا الاتصال بعد إيقاف مهامها قبل إزالة الربط.",
      409,
    );
  run("DELETE FROM servers WHERE id=?", id);
  return ok(c, { deleted: true });
});
