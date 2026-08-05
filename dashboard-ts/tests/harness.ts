/**
 * A dashboard backed by a throwaway database and a stubbed Docker.
 *
 * fleet.ts is the only module that touches Docker; stubbing it keeps the tests
 * runnable anywhere (CI included) without a daemon or a real desktop. The
 * stubs are deliberately stateful — `created`, `states`, `homes` — so a test
 * can drive the fleet the way Docker would and then assert on what the app
 * decided, rather than on what it called.
 */

import { mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as tar from "tar-stream";

const ROOT = process.env.DESKSWARM_TEST_ROOT!;

// ------------------------------------------------------------ fleet state

export const created = new Map<string, { port: number; image: string | null }>();
export const states = new Map<string, string>();
export const clipboards = new Map<string, string>();
export const pasted: [string, string][] = [];
/** A stand-in home directory per machine, kept as {path: bytes}. Backup tars
 *  it and restore replaces it, so the streaming, the gzip and the tar
 *  sanitising all run for real and only Docker is faked. */
export const homes = new Map<string, Map<string, Uint8Array>>();
export const snapshots = new Map<string, string>();
export const execLog: string[] = [];

export const realFleet = await import("../src/fleet");

/** Knobs the stubs read on every call, so a test can change the world
 *  mid-flight the way monkeypatching did. */
export const world = { bridgeUp: true, watchers: 0 };

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function homeArchiveStream(slug: string) {
  const pack = tar.pack();
  for (const [name, data] of homes.get(slug) ?? []) {
    pack.entry({ name: `cua/${name}`, size: data.length }, Buffer.from(data));
  }
  pack.finalize();
  const buf = await collect(pack as unknown as NodeJS.ReadableStream);
  const { Readable } = await import("node:stream");
  return Readable.from([buf]);
}

async function restoreHome(slug: string, tarPath: string, wipe = true) {
  if (wipe) homes.set(slug, new Map());
  const home = homes.get(slug) ?? new Map();
  homes.set(slug, home);

  const extract = tar.extract();
  const done = new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      // putArchive unpacks into /home, so members arrive as `cua/x`.
      const key = header.name.replace(/^cua\//, "");
      if (header.type === "symlink" || header.type === "link") {
        // Recorded, not skipped: a symlink that escapes the home directory is
        // every bit as dangerous as a '..' path, and dropping it here would
        // make the test that checks for it pass no matter what the code does.
        home.set(key, Buffer.from(`->${header.linkname}`));
        stream.resume();
        stream.on("end", next);
        return;
      }
      collect(stream as unknown as NodeJS.ReadableStream).then((body) => {
        if (header.type === "file") home.set(key, body);
        next();
      }, reject);
    });
    extract.on("finish", () => resolve());
    extract.on("error", reject);
  });
  const { createReadStream } = await import("node:fs");
  createReadStream(tarPath).pipe(extract as any);
  await done;
}

mock.module("../src/fleet", () => ({
  ...realFleet,
  ensureBridgeImage: async () => {},
  detectNetwork: async () => "test-net",
  usedNovncPorts: async () => new Set<number>(),
  createComputer: async (
    slug: string,
    port: number,
    _password: string,
    image?: string | null,
  ) => {
    created.set(slug, { port, image: image ?? null });
  },
  destroyComputer: async (slug: string) => {
    created.delete(slug);
  },
  // Container state is what the app reads to decide "is this machine asleep",
  // so tests drive it through this map rather than Docker.
  containerState: async (slug: string) => ({
    desktop_state: states.get(slug) ?? "running",
    bridge_state: states.get(slug) ?? "running",
  }),
  suspendComputer: async (slug: string) => {
    states.set(slug, "exited");
  },
  resumeComputer: async (slug: string) => {
    states.set(slug, "running");
  },
  isRunning: async (slug: string) => (states.get(slug) ?? "running") === "running",
  vncWatchers: async () => world.watchers,
  awakeMachineCount: async () =>
    [...created.keys()].filter((s) => (states.get(s) ?? "running") === "running").length,
  getClipboard: async (slug: string) => clipboards.get(slug) ?? "",
  setClipboard: async (slug: string, text: string) => {
    clipboards.set(slug, text);
  },
  pasteText: async (slug: string, text: string) => {
    clipboards.set(slug, text);
    pasted.push([slug, text]);
  },
  snapshotComputer: async (slug: string, tag: string) => {
    snapshots.set(tag, slug);
    return `img:${tag}`;
  },
  removeImage: async () => {},
  execInDesktopResult: async (_slug: string, command: string) => {
    execLog.push(command);
    return { ok: true, exit_code: 0, output: "" };
  },
  homeArchiveStream,
  restoreHome,
  listHome: async (slug: string, rel = "") => {
    realFleet.safeHomePath(rel);
    const prefix = rel ? `${rel}/` : "";
    const home = homes.get(slug) ?? new Map();
    return [...home.keys()]
      .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
      .map((k) => ({
        name: k.slice(prefix.length),
        type: "file",
        size: home.get(k)!.length,
      }));
  },
  uploadToHome: async (slug: string, relDir: string, filename: string, data: Uint8Array) => {
    realFleet.safeHomePath(relDir);
    if (filename.includes("/") || ["", ".", ".."].includes(filename)) {
      throw new realFleet.PathOutsideHome(`bad filename '${filename}'`);
    }
    const home = homes.get(slug) ?? new Map();
    homes.set(slug, home);
    const key = relDir ? `${relDir}/${filename}` : filename;
    home.set(key, data);
    return `/home/cua/${key}`;
  },
  downloadFromHome: async (slug: string, rel: string) => {
    realFleet.safeHomePath(rel);
    const body = homes.get(slug)?.get(rel);
    if (!body) throw new Error("no such file");
    return [Buffer.from(body), rel.split("/").pop() ?? rel, false];
  },
}));

// --------------------------------------------------------------- network

const realFetch = globalThis.fetch;

/**
 * The bridge, stubbed at the network edge rather than by patching the module
 * that calls it — which keeps `computerView` and `screens` running their real
 * code paths.
 */
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === "string" ? input : input?.url ?? "");
  if (url.endsWith("/status")) {
    if (!world.bridgeUp) return new Response("down", { status: 503 });
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "content-type": "application/json" },
    });
  }
  if (url.endsWith("/cmd")) {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    return new Response(
      `data: ${JSON.stringify({ success: true, image_data: png.toString("base64") })}\n`,
    );
  }
  return realFetch(input, init);
}) as typeof fetch;

// ------------------------------------------------------------------ app

const { app } = await import("../src/app");
const { closeDb } = await import("../src/db");
const { initDb } = await import("../src/schema");
const { dispatched } = await import("../src/tasks");

export { app, dispatched };

/** A clean database and clean stubs, for one test. */
export function reset(): void {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(process.env.DESKSWARM_DB_PATH + suffix, { force: true });
  }
  rmSync(join(ROOT, "backups"), { recursive: true, force: true });
  created.clear();
  states.clear();
  clipboards.clear();
  homes.clear();
  snapshots.clear();
  pasted.length = 0;
  execLog.length = 0;
  dispatched.length = 0;
  world.bridgeUp = true;
  world.watchers = 0;
  delete process.env.DESKSWARM_IDLE_SUSPEND_MINUTES;
  delete process.env.DESKSWARM_WAKE_TIMEOUT;
  initDb();
}

// -------------------------------------------------------------- requests

export interface Reply {
  status: number;
  json: any;
  text: string;
  /** The raw body. Downloads are gzip and PNG; decoding those as text and
   *  re-encoding them corrupts them. */
  bytes: Buffer;
  headers: Headers;
}

async function request(
  method: string,
  path: string,
  opts: { json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { host: "localhost", ...opts.headers };
  let body: BodyInit | undefined = opts.body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers["content-type"] = "application/json";
  }
  const res = await app.fetch(
    new Request(`http://localhost${path}`, { method, headers, body }),
  );
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString("utf8");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML partials, CSV and binary downloads are read as text/bytes */
  }
  return { status: res.status, json, text, bytes, headers: res.headers };
}

export const get = (p: string, o?: any) => request("GET", p, o);
export const post = (p: string, o?: any) => request("POST", p, o);
export const patch = (p: string, o?: any) => request("PATCH", p, o);
export const del = (p: string, o?: any) => request("DELETE", p, o);

/** Add a machine and return its id — the first line of most tests. */
export async function addMachine(name: string, extra: Record<string, unknown> = {}) {
  const r = await post("/api/v1/computers", { json: { name, ...extra } });
  return r;
}

export function seedHome(slug: string, files: Record<string, string>): void {
  const home = new Map<string, Uint8Array>();
  for (const [name, body] of Object.entries(files)) {
    home.set(name, Buffer.from(body));
  }
  homes.set(slug, home);
}

export const backupDir = (slug: string) => join(ROOT, "backups", slug);
export const backupExists = (slug: string, name: string) =>
  existsSync(join(backupDir(slug), name));
