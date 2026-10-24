import { Hono } from "hono";
import { fail, ok, jsonBody, type Env } from "../http";
import { requireToken } from "../security";
import { pageView } from "../page-view";
import * as cf from "../cloudflare/control";
import * as tunnels from "../cloudflare/tunnels";
import { tunnelHost } from "../cloudflare/tunnel-host";
export const cloudflareRoutes = new Hono<Env>();
cloudflareRoutes.use("/api/v1/cloudflare/*", async (c, next) => {
  cf.initCloudflare();
  c.header("Cache-Control", "no-store");
  c.set("auditDetail", "Cloudflare control operation; credentials omitted");
  return next();
});
cloudflareRoutes.get("/settings/cloudflare", c=>pageView(c,"cloudflare.html","/settings/cloudflare"));
cloudflareRoutes.get("/api/v1/cloudflare/status", (c) =>
  ok(c, {
    connection: cf.publicConfig(),
    jobs: cf.jobs(),
    tunnels: tunnels.publicTunnels(),
  }),
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

// Read-only discovery precedes any Tunnel/DNS/container changes.
cloudflareRoutes.post(
  "/api/v1/cloudflare/accounts",
  requireToken,
  async (c) => {
    try {
      const body = await jsonBody(c);
      return ok(c, await tunnels.accounts(String(body.token || "")));
    } catch {
      return fail(
        c,
        "تعذّر اكتشاف الحسابات؛ يمكنك إدخال Account ID يدويًا أو مراجعة صلاحية قراءة الحسابات",
        400,
      );
    }
  },
);
cloudflareRoutes.post("/api/v1/cloudflare/zones", requireToken, async (c) => {
  try {
    return ok(c, await tunnels.zones(await jsonBody(c)));
  } catch {
    return fail(
      c,
      "تعذّر تحميل الدومينات؛ تحقق من صلاحيات Zone Read وDNS Edit والحساب",
      400,
    );
  }
});
cloudflareRoutes.post("/api/v1/cloudflare/targets", requireToken, async (c) => {
  try {
    const body = await jsonBody(c),
      id = Number(body.server_id);
    if (!Number.isInteger(id) || id < 0)
      return fail(c, "اختر سيرفرًا صالحًا", 400);
    return ok(c, await tunnelHost.discover(id));
  } catch {
    return fail(c, "تعذّر اكتشاف الخدمة؛ تحقق من اتصال SSH وDocker", 400);
  }
});
cloudflareRoutes.post(
  "/api/v1/cloudflare/tunnel/test",
  requireToken,
  async (c) => {
    try {
      return ok(c, await tunnels.prepare(await jsonBody(c)));
    } catch (e) {
      return fail(
        c,
        e instanceof Error &&
          /^(Account|اسم |اختر |أدخل |النطاق |هذا |خدمة |فعّل |Cloudflare )/.test(
            e.message,
          )
          ? e.message
          : "تعذّر فحص Tunnel؛ تحقق من الحساب والدومين وSSH وDocker",
        400,
      );
    }
  },
);
cloudflareRoutes.post("/api/v1/cloudflare/tunnel", requireToken, async (c) => {
  try {
    return ok(c, tunnels.start(await jsonBody(c)), 202);
  } catch (e) {
    return fail(
      c,
      e instanceof Error && /^(اختبر |انتظر |إعدادات )/.test(e.message)
        ? e.message
        : "تعذّر بدء إعداد Tunnel",
      409,
    );
  }
});
cloudflareRoutes.post(
  "/api/v1/cloudflare/tunnels/:id/stop",
  requireToken,
  async (c) => {
    try {
      return ok(c, await tunnels.stop(Number(c.req.param("id"))));
    } catch {
      return fail(
        c,
        "تعذّر إيقاف النفق؛ انتظر النشر الجاري وتحقق من اتصال السيرفر",
        409,
      );
    }
  },
);

cloudflareRoutes.post(
  "/api/v1/cloudflare/tunnels/:id/check",
  requireToken,
  async (c) => {
    try {
      return ok(c, await tunnels.check(Number(c.req.param("id"))));
    } catch {
      return fail(c, "تعذّر الفحص؛ انتظر العملية الجارية أو راجع النفق", 409);
    }
  },
);
