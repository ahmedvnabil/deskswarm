/** Offline preparation prototype. Not deployed or connected to the live runner. */
export class CloudSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(request) {
    if (
      !this.env.COMPUTE_SECRET ||
      request.headers.get("authorization") !==
        `Bearer ${this.env.COMPUTE_SECRET}`
    )
      return Response.json({ error: "unauthorized" }, { status: 401 });
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/state") {
      const state = await this.ctx.storage.get("state");
      return Response.json({
        lease: state?.until > Date.now() ? state : null,
        execution_connected: false,
      });
    }
    if (request.method !== "POST")
      return Response.json({ error: "not found" }, { status: 404 });
    const body = await request.json().catch(() => null);
    if (!body || !/^run-[1-9][0-9]{0,11}$/.test(body.owner || ""))
      return Response.json({ error: "invalid owner" }, { status: 400 });
    return this.ctx.storage.transaction(async (tx) => {
      const previous = await tx.get("state"),
        active = previous?.until > Date.now();
      if (path === "/reserve") {
        if (active && previous.owner !== body.owner)
          return Response.json({ error: "already owned" }, { status: 409 });
        const seconds = Number(body.seconds || 300);
        if (!Number.isInteger(seconds) || seconds < 10 || seconds > 900)
          return Response.json({ error: "invalid lease" }, { status: 400 });
        const lease = { owner: body.owner, until: Date.now() + seconds * 1000 };
        await tx.put("state", lease);
        return Response.json({ lease, execution_connected: false });
      }
      if (path === "/release") {
        if (active && previous.owner !== body.owner)
          return Response.json({ error: "owner mismatch" }, { status: 409 });
        await tx.delete("state");
        return Response.json({ released: true });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    });
  }
}
export default {
  async fetch(request, env) {
    if (
      !env.COMPUTE_SECRET ||
      request.headers.get("authorization") !== `Bearer ${env.COMPUTE_SECRET}`
    )
      return Response.json({ error: "unauthorized" }, { status: 401 });
    const match = new URL(request.url).pathname.match(
      /^\/sessions\/([a-z0-9][a-z0-9-]{0,62})\/(state|reserve|release)$/,
    );
    if (!match) return Response.json({ error: "not found" }, { status: 404 });
    const url = new URL(request.url);
    url.pathname = "/" + match[2];
    return env.SESSIONS.get(env.SESSIONS.idFromName(match[1])).fetch(
      new Request(url, request),
    );
  },
};
