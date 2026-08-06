/**
 * The response envelope, in one place.
 *
 * Every JSON endpoint answers `{ok, data, error}` — the shape the API has
 * always had and the one APIs.md documents. Building it by hand in each
 * handler is how a field quietly goes missing from one of them.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface Vars {
  auditTarget?: string | null;
  auditDetail?: string | null;
  actor?: string;
  userId?: number;
}

export type Env = { Variables: Vars };

export const ok = (c: Context<Env>, data: unknown, status = 200, meta?: unknown) =>
  c.json(
    meta === undefined
      ? { ok: true, data, error: null }
      : { ok: true, data, error: null, meta },
    status as ContentfulStatusCode,
  );

export const fail = (
  c: Context<Env>,
  error: string,
  status = 400,
  data: unknown = null,
) => c.json({ ok: false, data, error }, status as ContentfulStatusCode);

export const notFound = (c: Context<Env>) => fail(c, "not found", 404);

/** Parse a JSON body without throwing on an empty or malformed one — Flask's
 *  `request.get_json(silent=True) or {}`. */
export async function jsonBody(c: Context<Env>): Promise<Record<string, any>> {
  try {
    return (await c.req.json()) ?? {};
  } catch {
    return {};
  }
}

/** Path params arrive as strings; every numeric route needs the same guard. */
export function intParam(c: Context<Env>, name: string): number | null {
  const n = parseInt(c.req.param(name) ?? "", 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * The hostname the browser used to reach us.
 *
 * The machines' screens are published on this host's ports, so the link to
 * them has to name a host the *browser* can reach. Deriving it from the
 * request means opening the dashboard at a LAN address just works, instead of
 * showing black screens until someone finds DESKSWARM_PUBLIC_HOST.
 */
export function browserHost(c: Context<Env>): string | null {
  const host = c.req.header("host") || "";
  return host.replace(/:\d+$/, "") || null;
}

/** The client address, as far as we can tell from behind a proxy. */
export function sourceIp(c: Context<Env>): string {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return (c.env as any)?.server?.requestIP?.(c.req.raw)?.address ?? "";
}
