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
