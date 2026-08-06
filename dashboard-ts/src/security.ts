/**
 * Who may change things, and from where.
 *
 * The cross-site check and the audit hook are two halves of the same concern —
 * one refuses requests the user did not make, the other records the ones that
 * got through — so they live together.
 */

import type { MiddlewareHandler } from "hono";
import * as audit from "./audit";
import * as auth from "./auth";
import { DASHBOARD_TOKEN } from "./settings";
import { fail, sourceIp, type Env } from "./http";

export const SESSION_COOKIE = "deskswarm_session";

/**
 * Paths that answer without a session, and why each one has to.
 *
 *   /health      the container healthcheck, and anything watching from outside
 *   /login       the way in
 *   /s/<token>   a share is a link you hand to someone who has no account —
 *                putting it behind the login would delete the feature
 *   /mcp/<slug>  an MCP client holds a key for one machine and has no session
 *                to offer. Not unauthenticated: the route does its own bearer
 *                check against mcp_keys, and a key names exactly one machine.
 *                Left inside the cross-site check on purpose — MCP's own
 *                transport spec asks servers to validate Origin, and a real
 *                client sends none at all.
 */
const PUBLIC = (path: string): boolean =>
  path === "/health" ||
  path === "/login" ||
  path === "/logout" ||
  path.startsWith("/s/") ||
  path.startsWith("/mcp/");

const readCookie = (header: string | undefined, name: string): string | null => {
  for (const part of (header ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
};

/**
 * Everything needs a person or a token behind it.
 *
 * The token path exists because scripts were here first: n8n, cron and curl
 * have been driving this with DASHBOARD_TOKEN, and a login page would break
 * every one of them. A browser gets a redirect to /login; an API client gets
 * a 401 in the usual envelope, because a redirect to HTML is useless to it.
 */
export const requireSession: MiddlewareHandler<Env> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (PUBLIC(path)) return next();

  const supplied = (c.req.header("authorization") || "").replace(/^Bearer /, "").trim();
  if (DASHBOARD_TOKEN && supplied && auth.sameToken(supplied, DASHBOARD_TOKEN)) {
    c.set("actor", "token");
    return next();
  }

  const session = auth.resolveSession(readCookie(c.req.header("cookie"), SESSION_COOKIE));
  if (session) {
    auth.touchSession(session.id);
    c.set("actor", session.username ?? "user");
    c.set("userId", session.user_id);
    return next();
  }

  const wantsHtml = (c.req.header("accept") || "").includes("text/html");
  if (wantsHtml) {
    const back = encodeURIComponent(path + (new URL(c.req.url).search || ""));
    return c.redirect(`/login?next=${back}`, 302);
  }
  return fail(c, "unauthorized", 401);
};

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
  // Compared against the forwarded host as well as Host. Caddy preserves the
  // original Host, but nginx and Traefik can be configured to replace it with
  // the upstream address, and then every form post from the real site looks
  // foreign. This is not a hole: a browser making a cross-site "simple
  // request" — the whole thing this defends against — cannot set
  // X-Forwarded-Host, because it is not a CORS-safelisted header. Anything
  // that *can* set it sends no Origin and was already allowed through.
  const forwarded = (c.req.header("x-forwarded-host") || "").split(",")[0].trim();
  if (host !== c.req.header("host") && host !== forwarded) {
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

/**
 * Guard a mutating route when DASHBOARD_TOKEN is set.
 *
 * Kept alongside requireSession rather than replaced by it: a signed-in person
 * has already passed the session check, and a script that has been sending
 * this header for months should keep working unchanged.
 */
export const requireToken: MiddlewareHandler<Env> = async (c, next) => {
  if (!DASHBOARD_TOKEN) return next();
  // A signed-in browser has already been identified; the token is for the
  // clients that have no session to offer.
  if (c.get("actor") && c.get("actor") !== "token") return next();
  const supplied = (c.req.header("authorization") || "")
    .replace(/^Bearer /, "")
    .trim();
  if (!supplied || !auth.sameToken(supplied, DASHBOARD_TOKEN)) {
    return fail(c, "unauthorized", 401);
  }
  return next();
};
