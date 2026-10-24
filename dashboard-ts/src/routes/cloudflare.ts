import { Hono } from "hono";
import { fail, ok, jsonBody, type Env } from "../http";
import { requireToken } from "../security";
import { render } from "../templates";
import * as cf from "../cloudflare/control";
export const cloudflareRoutes = new Hono<Env>();
cloudflareRoutes.use("/api/v1/cloudflare/*", async (c, next) => {
  cf.initCloudflare();
  c.header("Cache-Control", "no-store");
  c.set("auditDetail", "Cloudflare control operation; credentials omitted");
  return next();
});
cloudflareRoutes.get("/settings/cloudflare", (c) => {
  c.header("Cache-Control", "no-store");
  return c.html(render("cloudflare.html", {}));
});
cloudflareRoutes.get("/api/v1/cloudflare/status", (c) =>
  ok(c, { connection: cf.publicConfig(), jobs: cf.jobs() }),
);
cloudflareRoutes.post("/api/v1/cloudflare/test", requireToken, async (c) => {
  try {
    return ok(c, await cf.testConnection(cf.validate(await jsonBody(c))));
  } catch (e) {
    return fail(
      c,
      e instanceof Error &&
        /^(أدخل|Account|اسم Worker|فعّل|خدمة Linux|Cloudflare)/.test(e.message)
        ? e.message
        : "تعذّر اختبار الاتصال؛ تحقق من البيانات والشبكة",
      400,
    );
  }
});
cloudflareRoutes.post(
  "/api/v1/cloudflare/connection",
  requireToken,
  async (c) => {
    try {
      const body = await jsonBody(c);
      return ok(
        c,
        cf.saveConnection(cf.validate(body), String(body.test_token || "")),
      );
    } catch {
      return fail(
        c,
        "تعذّر الحفظ. اختبر نفس الإعدادات أولًا وانتظر انتهاء أي نشر جارٍ",
        400,
      );
    }
  },
);
cloudflareRoutes.get("/api/v1/cloudflare/versions", async (c) => {
  try {
    return ok(c, await cf.versions());
  } catch {
    return fail(c, "تعذّر تحميل الإصدارات من Cloudflare", 502);
  }
});
for (const kind of ["deploy", "rollback"] as const) {
  cloudflareRoutes.post(
    `/api/v1/cloudflare/${kind}`,
    requireToken,
    async (c) => {
      try {
        const body = await jsonBody(c);
        return ok(c, { id: cf.startJob(kind, body.version) }, 202);
      } catch {
        return fail(
          c,
          "اربط الحساب أولًا، واختر إصدارًا صالحًا للرجوع، وانتظر انتهاء العملية الجارية",
          409,
        );
      }
    },
  );
}
