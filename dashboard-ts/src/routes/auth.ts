/** Signing in, and signing out. */

import { Hono } from "hono";
import * as auth from "./../auth";
import { render } from "./../templates";
import { SESSION_COOKIE } from "./../security";
import { sourceIp, type Env } from "./../http";

export const authRoutes = new Hono<Env>();

/**
 * Where to send someone after they sign in.
 *
 * Only a path on this dashboard. `next=https://evil.example` would otherwise
 * turn the login page into an open redirect, which is how a phishing link
 * gets to borrow a real domain — and `//evil.example` is a path to a browser
 * but a host to a careless check.
 */
function safeNext(raw: string | undefined | null): string {
  const value = (raw ?? "").trim();
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

const cookieFor = (c: any, token: string, maxAgeSeconds: number): string => {
  // Secure only over HTTPS: setting it unconditionally would make the cookie
  // vanish on a plain-HTTP LAN install, which is how most of these run.
  const proto = c.req.header("x-forwarded-proto") || new URL(c.req.url).protocol;
  const secure = String(proto).startsWith("https") ? "; Secure" : "";
  return (
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; ` +
    `SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`
  );
};

authRoutes.get("/login", (c) => {
  return c.html(
    render("login.html", {
      next: safeNext(c.req.query("next")),
      username: "",
      error: null,
      session_days: Math.round(auth.SESSION_HOURS / 24),
    }),
  );
});

authRoutes.post("/login", async (c) => {
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const username = String(form.username ?? "").trim();
  const password = String(form.password ?? "");
  const next = safeNext(String(form.next ?? "/"));
  const ip = sourceIp(c) || "unknown";

  const page = (error: string, status = 401) =>
    c.html(
      render("login.html", {
        next,
        username,
        error,
        session_days: Math.round(auth.SESSION_HOURS / 24),
      }),
      status as any,
    );

  const locked = auth.lockedOutFor(ip);
  if (locked > 0) {
    c.set("auditDetail", `locked out (${username || "no username"})`);
    return page(`too many attempts — try again in ${locked} minute(s)`, 429);
  }

  const user = await auth.verifyPassword(username, password);
  if (!user) {
    auth.noteFailure(ip);
    // One message for both "no such user" and "wrong password": saying which
    // tells a stranger whether the username is worth more guesses.
    c.set("auditDetail", `failed sign-in for '${username}'`);
    return page("wrong username or password");
  }

  auth.clearFailures(ip);
  const token = auth.startSession(user.id, ip, c.req.header("user-agent") ?? null);
  c.set("actor", user.username);
  c.set("auditDetail", `signed in as '${user.username}'`);
  c.header("set-cookie", cookieFor(c, token, auth.SESSION_HOURS * 3600));
  return c.redirect(next, 302);
});

authRoutes.post("/logout", (c) => {
  const cookie = c.req.header("cookie") ?? "";
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  auth.endSession(match ? decodeURIComponent(match[1]) : null);
  c.header("set-cookie", cookieFor(c, "", 0));
  return c.redirect("/login", 302);
});
