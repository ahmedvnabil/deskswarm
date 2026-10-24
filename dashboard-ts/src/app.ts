/**
 * The application: middleware, then one router per slice of the URL space.
 *
 * Kept apart from server.ts so tests can drive `app.fetch(...)` without a
 * listening socket or a port to collide on.
 */

import { Hono } from "hono";
import { blockCrossSite, requireSession, writeAudit } from "./security";
import { initDb } from "./schema";
import { fail, type Env } from "./http";

import { authRoutes } from "./routes/auth";
import { system } from "./routes/system";
import { machines } from "./routes/machines";
import { files } from "./routes/files";
import { snapshots } from "./routes/snapshots";
import { backupRoutes } from "./routes/backups";
import { shares } from "./routes/shares";
import { keyRoutes } from "./routes/keys";
import { mcpRoutes } from "./routes/mcp";
import { auditRoutes } from "./routes/audit";
import { serverRoutes } from "./routes/servers";
import { connectionRoutes } from "./routes/connections";
import { cloudflareRoutes } from "./routes/cloudflare";
import { remoteScreens } from "./routes/remote-screen";
import { agentRoutes } from "./routes/agents";
import { owner, beginExternalAction } from "./agents/store";

export function createApp() {
  initDb();

  const app = new Hono<Env>();

  // writeAudit first: it wraps the rest, so a request blocked below still
  // leaves a line. The other order — which this had — meant the one category
  // of request most worth recording was the only one that vanished silently.
  app.use("*", writeAudit);
  app.use("*", blockCrossSite);
  // After the audit hook so a refused sign-in still leaves a line, and before
  // every router so nothing can be reached without a person or a token.
  app.use("*", requireSession);

  // Managed runs own machine mutations until their in-flight action drains.
  app.use("/api/v1/computers/*", async (c, next) => {
    const match = c.req.path.match(/^\/api\/v1\/computers\/(\d+)(?:\/|$)/);
    if (
      match &&
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      owner(Number(match[1]))
    )
      return fail(
        c,
        "An agent owns this machine. Stop it or take control from Agents first.",
        409,
      );
    if (!match || ["GET", "HEAD", "OPTIONS"].includes(c.req.method))
      return next();
    const release = beginExternalAction(Number(match[1]));
    try {
      return await next();
    } finally {
      release();
    }
  });

  // Order matters only where paths overlap; each router owns a disjoint slice.
  for (const router of [
    authRoutes,
    system,
    machines,
    files,
    snapshots,
    backupRoutes,
    shares,
    keyRoutes,
    mcpRoutes,
    auditRoutes,
    agentRoutes,
    serverRoutes,
    cloudflareRoutes,
    connectionRoutes,
    remoteScreens,
  ]) {
    app.route("/", router);
  }

  // An unhandled exception in a handler is a 500 in the same envelope as every
  // other error, not an HTML stack trace.
  app.onError((err, c) => {
    console.error(err);
    return fail(c, String(err?.message ?? err), 500);
  });

  app.notFound((c) => fail(c, "not found", 404));

  return app;
}

export const app = createApp();
