/**
 * Who may change things, and from where.
 *
 * The cross-site check and the audit hook are two halves of the same concern —
 * one refuses requests the user did not make, the other records the ones that
 * got through — so they live together.
 */

import type { MiddlewareHandler } from "hono";
import * as audit from "./audit";
import { DASHBOARD_TOKEN } from "./settings";
import { fail, sourceIp, type Env } from "./http";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Reject state-changing requests that a *browser* sends from another site.
 *
 * Without this, any page the user visits could auto-submit a plain HTML form
 * at this dashboard. Form posts are "simple requests", so they are sent with
 * no CORS preflight to stop them — and POST /computers/<id>/exec runs a shell
 * command as root inside a machine. That is remote code execution triggered by
 * nothing more than visiting a web page.
 *
 * Browsers always attach Origin to a cross-site state-changing request, so
 * rejecting a *present but foreign* Origin closes the hole. Non-browser
 * clients (curl, n8n, cron) send no Origin at all and keep working; they are
 * not a CSRF vector because no one else controls them.
 */
export const blockCrossSite: MiddlewareHandler<Env> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const source = c.req.header("origin") || c.req.header("referer");
  if (!source) return next();
  let host: string;
  try {
    host = new URL(source).host;
  } catch {
    return fail(c, "cross-site request blocked", 403);
  }
  if (host !== c.req.header("host")) {
    return fail(c, "cross-site request blocked", 403);
  }
  return next();
};

/**
 * Record every state-changing request, once, in one place.
 *
 * Deliberately middleware rather than a call inside each handler: a log you
 * have to remember to write is a log with holes, and the holes land in
 * whichever endpoint was added last — usually the interesting one.
 *
 * Handlers add context with `c.set("auditTarget", …)` / `auditDetail`. What
 * they must not put there is content: the shell command is recorded because
 * that is the whole point, but clipboard text and file bodies are only counted.
 */
export const writeAudit: MiddlewareHandler<Env> = async (c, next) => {
  await next();
  try {
    const path = new URL(c.req.url).pathname;
    if (audit.shouldRecord(c.req.method, path)) {
      audit.record(`${c.req.method} ${path}`, {
        actor: c.get("actor") ?? "dashboard",
        source_ip: sourceIp(c),
        target: c.get("auditTarget") ?? null,
        detail: c.get("auditDetail") ?? null,
        status: c.res.status,
        ok: c.res.status < 400,
      });
    }
  } catch {
    // An audit failure must never break the request itself.
  }
};

/** Guard a mutating route when DASHBOARD_TOKEN is set. */
export const requireToken: MiddlewareHandler<Env> = async (c, next) => {
  if (!DASHBOARD_TOKEN) return next();
  const supplied = (c.req.header("authorization") || "")
    .replace(/^Bearer /, "")
    .trim();
  if (supplied !== DASHBOARD_TOKEN) return fail(c, "unauthorized", 401);
  return next();
};
