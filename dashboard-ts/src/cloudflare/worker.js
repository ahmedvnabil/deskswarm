/** Edge entry point. Linux remains authoritative for authentication and leases. */
export class DeviceSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(request) {
    // Persist coordination metadata; never retain cookies, tasks or credentials.
    await this.ctx.storage.put("lastRequestAt", Date.now());
    if (new URL(request.url).pathname === "/_edge/health") {
      try {
        const response = await fetch(`${this.env.ORIGIN}/health`, {
          redirect: "manual",
        });
        const health = await response.json();
        if (!response.ok || health.status !== "ok") throw Error("unhealthy");
        return Response.json({
          status: "ok",
          architecture: "worker-durable-object-linux",
          release: this.env.RELEASE,
        });
      } catch {
        return new Response("Linux execution service unavailable", {
          status: 502,
        });
      }
    }
    return proxy(request, this.env);
  }
}
export async function proxy(request, env) {
  const external = new URL(request.url);
  const target = new URL(env.ORIGIN);
  target.pathname = external.pathname;
  target.search = external.search;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("x-forwarded-for");
  headers.set("x-forwarded-host", external.host);
  headers.set("x-forwarded-proto", "https");
  headers.delete("x-deskswarm-edge");
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) headers.set("x-forwarded-for", ip);
  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    });
    if (response.status === 101) return response;
    const out = new Response(response.body, response);
    out.headers.set("cache-control", "no-store");
    const location = out.headers.get("location");
    if (location) {
      const redirect = new URL(location, target);
      if (redirect.origin === target.origin) {
        redirect.protocol = external.protocol;
        redirect.hostname = external.hostname;
        redirect.port = external.port;
        out.headers.set("location", redirect.toString());
      }
    }
    return out;
  } catch {
    return new Response("Linux execution service unavailable", { status: 502 });
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/_edge/health") {
      if (request.headers.get("authorization") !== `Bearer ${env.EDGE_SECRET}`)
        return new Response("Unauthorized", { status: 401 });
      return env.DEVICES.get(env.DEVICES.idFromName("system:health")).fetch(
        request,
      );
    }
    // Device routes share a stable object. Actual ownership is enforced by Linux,
    // including requests arriving directly at the Linux service.
    const machine = url.pathname.match(
      /^\/(?:api\/v1\/computers|remote-screen)\/(\d+)(?:\/|$)/,
    );
    if (machine) {
      const id = env.DEVICES.idFromName(`device:${machine[1]}`);
      return env.DEVICES.get(id).fetch(request);
    }
    return proxy(request, env);
  },
};
