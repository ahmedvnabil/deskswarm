import { Hono } from "hono";
import { ok, fail, jsonBody, type Env } from "../http";
import { requireToken } from "../security";
import { pageView } from "../page-view";
import * as proxmox from "../connections/proxmox";
import * as netbird from "../connections/netbird";
import { publicConfig, jobs } from "../cloudflare/control";
import { publicTunnels } from "../cloudflare/tunnels";
import { serverRows } from "../servers";
export const connectionRoutes = new Hono<Env>();
connectionRoutes.get("/settings/connections",c=>pageView(c,"connections.html","/settings/connections"));
connectionRoutes.use("/api/v1/connections/*", async (c, next) => {
  c.header("cache-control", "no-store");
  c.set("auditDetail", "Connection preferences; credentials omitted");
  return next();
});
connectionRoutes.get("/api/v1/connections/status", (c) =>
  ok(c, {
    cloudflare: publicConfig(),
    tunnels: publicTunnels(),
    netbird: netbird.status(),
    servers: serverRows().map((s) => ({
      id: s.id,
      name: s.name,
      host: s.host,
      status: s.status,
      checked_at: s.checked_at,
    })),
    preferences: netbird.preferences(),
  }),
);
connectionRoutes.post(
  "/api/v1/connections/preferences",
  requireToken,
  async (c) => {
    try {
      return ok(c, netbird.savePreferences(await jsonBody(c)));
    } catch {
      return fail(c, "اسم مستخدم SSH أو المنفذ غير صالح", 400);
    }
  },
);
connectionRoutes.use("/api/v1/netbird/*", async (c, next) => {
  c.header("cache-control", "no-store");
  c.set("auditDetail", "NetBird connection; credentials omitted");
  return next();
});
connectionRoutes.get("/api/v1/netbird/peers", (c) =>
  ok(c, { connection: netbird.status(), peers: netbird.peers() }),
);
connectionRoutes.post("/api/v1/netbird/peers/:id/diagnostic", requireToken, async c => {
  try { return ok(c, netbird.recordDiagnostic(c.req.param("id"), await jsonBody(c))); }
  catch { return fail(c, "تعذّر حفظ تشخيص الجهاز", 400); }
});
connectionRoutes.post("/api/v1/netbird/peers/:id/retry", requireToken, async c => {
  try { return ok(c, await netbird.retryPeer(c.req.param("id"))); }
  catch (error) { return fail(c, error instanceof Error && /^(فشل|فشلت|جهّز|إعادة|الجهاز)/.test(error.message) ? error.message : "تعذّرت إعادة محاولة الربط", 400); }
});
for (const action of ["test", "connection", "sync"] as const) {
  connectionRoutes.post(
    `/api/v1/netbird/${action}`,
    requireToken,
    async (c) => {
      try {
        const body = await jsonBody(c);
        return ok(
          c,
          await (action === "test"
            ? netbird.testConnection(body)
            : action === "connection"
              ? netbird.save(body)
              : netbird.sync()),
        );
      } catch (e) {
        return fail(
          c,
          e instanceof Error &&
            /^(أدخل|اختبر|تعذّر|اربط|استجابة|صيغة)/.test(e.message)
            ? e.message
            : "تعذّر اتصال NetBird؛ تحقق من العنوان وPAT والشبكة",
          400,
        );
      }
    },
  );
}

connectionRoutes.get("/api/v1/connections/proxmox", c=>ok(c,proxmox.publicProxmox()));
for(const action of ["discover","settings","create"] as const) connectionRoutes.post(`/api/v1/connections/proxmox/${action}`,requireToken,async c=>{
  c.set("auditDetail","Proxmox "+action+"; credentials omitted");
  try{const body=await jsonBody(c);return ok(c,await (action==="discover"?proxmox.discover(Number(body.server_id)):action==="settings"?proxmox.saveProxmox(body):proxmox.createCT(body)))}
  catch(error){return fail(c,error instanceof Error && /^(اختر|قيمة|موارد|توجد|تعذّر|فشلت|القالب|مساحة|لم )/.test(error.message)?error.message:"تعذّر تنفيذ طلب Proxmox",400)}
});
