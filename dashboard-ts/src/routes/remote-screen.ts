/** Authenticated same-origin noVNC transport over the pinned SSH connection. */
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { join } from "node:path";
import WebSocket from "ws";
import { owner } from "../agents/store";
import { getComputer } from "../machines";
import { serverById, forwardScreen, channelSocket } from "../servers";
import { fail, type Env } from "../http";
export const remoteScreens = new Hono<Env>();
function target(id: string) {
  const comp = getComputer(Number(id));
  const match = comp?.provider?.match(/^server:(\d+)$/);
  const row = match ? serverById(Number(match[1])) : null;
  return comp && row ? { comp, row } : null;
}
remoteScreens.get(
  "/remote-screen/:id/websockify",
  async (c, next) => {
    const origin = c.req.header("origin");
    let sameOrigin = false;
    try {
      const source = new URL(origin || "");
      const forwarded = (c.req.header("x-forwarded-host") || "")
        .split(",")[0]
        .trim();
      sameOrigin =
        ["http:", "https:"].includes(source.protocol) &&
        (source.host === new URL(c.req.url).host ||
          (!!forwarded && source.host === forwarded));
    } catch {}
    if (!sameOrigin) return fail(c, "Screen origin refused", 403);
    if (!target(c.req.param("id"))) return fail(c, "Screen not found", 404);
    return next();
  },
  upgradeWebSocket((c) => {
    const { comp, row } = target(c.req.param("id") || "")!;
    let upstream: WebSocket | undefined,
      closeTunnel: (() => void) | undefined,
      closed = false;
    const pending: Buffer[] = [];
    let pendingBytes = 0;
    return {
      async onOpen(_event, ws) {
        try {
          const tunnel = await forwardScreen(row, comp.novnc_port);
          closeTunnel = tunnel.close;
          if (closed) {
            tunnel.close();
            return;
          }
          upstream = new WebSocket(
            `ws://127.0.0.1:${comp.novnc_port}/websockify`,
            ["binary"],
            {
              createConnection: () => channelSocket(tunnel.stream) as any,
              handshakeTimeout: 10000,
              maxPayload: 4 * 1024 * 1024,
              perMessageDeflate: false,
            },
          );
          upstream.on("open", () => {
            for (const data of pending) upstream!.send(data);
            pending.length = 0;
            pendingBytes = 0;
          });
          upstream.on("message", (data) => {
            if (!closed) ws.send(Buffer.from(data as Buffer));
          });
          upstream.on("close", () => {
            closeTunnel?.();
            if (!closed) ws.close();
          });
          upstream.on("error", () => {
            closeTunnel?.();
            if (!closed) ws.close(1011, "Screen unavailable");
          });
        } catch {
          if (!closed) ws.close(1011, "SSH screen unavailable");
        }
      },
      onMessage(event, ws) {
        const data =
          typeof event.data === "string"
            ? Buffer.from(event.data)
            : Buffer.from(event.data as ArrayBuffer);
        if (data.length > 1024 * 1024) {
          ws.close(1009);
          return;
        }
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(data);
        else {
          pendingBytes += data.length;
          if (pendingBytes > 1024 * 1024) {
            ws.close(1009);
            return;
          }
          pending.push(data);
        }
      },
      onClose() {
        closed = true;
        upstream?.terminate();
        closeTunnel?.();
      },
      onError() {
        closed = true;
        upstream?.terminate();
        closeTunnel?.();
      },
    };
  }),
);
remoteScreens.get("/remote-screen/:id/*", async (c) => {
  const selected = target(c.req.param("id"));
  if (!selected) return fail(c, "Screen not found", 404);
  const path =
    c.req.path.split(`/remote-screen/${selected.comp.id}/`)[1] || "vnc.html";
  if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split("/").includes(".."))
    return fail(c, "Invalid screen path", 400);
  if(path==="defaults.json")return c.json({},200,{"cache-control":"no-store"});
  if(path==="mandatory.json")return c.json({host:"",port:0,path:`/remote-screen/${selected.comp.id}/websockify`,shared:true,...(owner(selected.comp.id)?{view_only:true}:{})},200,{"cache-control":"no-store"});
  // Serve a pinned, application-owned client. A container (or its agent)
  // must never inject JavaScript into the dashboard's authenticated origin.
  const file = Bun.file(join(import.meta.dir, "../../static/novnc", path));
  if (!(await file.exists())) return fail(c, "Screen asset not found", 404);
  return new Response(file, {
    headers: {
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "frame-ancestors 'self'",
    },
  });
});
