/**
 * Everything about a machine except its routes.
 *
 * Queries, the view a machine is rendered as, creation, and sleep/wake. The
 * routes on top of this are in routes/machines.ts.
 */

import {
  defaultProviderName,
  providerByName,
  providerFor,
  providerNames,
  randomVncPassword,
  slugify,
} from "./providers";
import { all, one, run } from "./db";
import { MAX_BULK_CREATE, envFloat, nowIso } from "./settings";

export interface Computer {
  id: number;
  name: string;
  slug: string;
  novnc_port: number;
  vnc_password: string;
  image: string | null;
  reserved: number;
  no_suspend: number;
  last_active_at: string | null;
  provider: string | null;
  created_at: string;
}

/** A user-facing problem the route layer turns into a 400. */
export class ValidationError extends Error {}

export const listComputers = (): Computer[] =>
  all<Computer>("SELECT * FROM computers ORDER BY id");

export const getComputer = (id: number): Computer | null =>
  one<Computer>("SELECT * FROM computers WHERE id = ?", id);

export const getComputerByName = (name: string): Computer | null =>
  one<Computer>("SELECT * FROM computers WHERE name = ?", name);

export interface ComputerView {
  id: number;
  name: string;
  slug: string;
  novnc_port: number;
  novnc_url: string;
  vnc_password: string;
  bridge_host: string;
  bridge_port: number;
  created_at: string;
  reserved: boolean;
  no_suspend: boolean;
  last_active_at: string | null;
  bridge_ok: boolean;
  sleeping: boolean;
  desktop_state?: string;
  bridge_state?: string;
  error?: string;
  active_task?: unknown;
}

export async function computerView(
  comp: Computer,
  opts: { withState?: boolean; host?: string | null } = {},
): Promise<ComputerView> {
  const withState = opts.withState !== false;
  const backend = providerFor(comp);
  const bridge = backend.bridgeEndpoint(comp.slug);
  const view: ComputerView = {
    id: comp.id,
    name: comp.name,
    slug: comp.slug,
    novnc_port: comp.novnc_port,
    novnc_url: backend.novncUrl(comp.novnc_port, comp.vnc_password, opts.host),
    vnc_password: comp.vnc_password,
    bridge_host: bridge.host,
    bridge_port: bridge.port,
    created_at: comp.created_at,
    reserved: !!comp.reserved,
    no_suspend: !!comp.no_suspend,
    last_active_at: comp.last_active_at,
    bridge_ok: false,
    sleeping: false,
  };
  if (withState) {
    try {
      Object.assign(view, await backend.containerState(comp.slug));
    } catch (err: any) {
      view.error = String(err?.message ?? err);
    }
    view.sleeping = view.desktop_state === "exited";
    // Probing a stopped bridge just burns the full HTTP timeout, once per
    // machine per refresh — on a wall of sleeping machines that alone made the
    // page slower than its own poll interval.
    if (view.bridge_state === "running") {
      view.bridge_ok = await checkBridge(view);
    }
  }
  return view;
}

export async function checkBridge(view: {
  bridge_host: string;
  bridge_port: number;
}): Promise<boolean> {
  try {
    const res = await fetch(`http://${view.bridge_host}:${view.bridge_port}/status`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.status !== 200) return false;
    return (await res.json())?.status === "ok";
  } catch {
    return false;
  }
}

/**
 * Build the view for every machine at once.
 *
 * Each machine costs two Docker inspects plus a bridge probe. Done serially
 * that is a few hundred milliseconds per machine, so a wall of 24 would take
 * longer to render than its own 5s refresh interval. Order is preserved.
 */
export async function computerViews(
  comps: Computer[],
  host?: string | null,
): Promise<ComputerView[]> {
  if (!comps.length) return [];
  return Promise.all(comps.map((c) => computerView(c, { host })));
}

/**
 * Machines to charge against the memory budget: the awake ones.
 *
 * Falls back to the whole fleet if Docker can't be asked — over-counting is
 * the safe direction for an admission check.
 */
export async function budgetedMachineCount(): Promise<number> {
  const counts = await Promise.all(
    providerNames().map((n) => providerByName(n).awakeMachineCount()),
  );
  // One backend that cannot answer makes the whole number a guess, and
  // over-counting is the safe direction for an admission check.
  if (counts.some((c) => c === null)) return listComputers().length;
  return (counts as number[]).reduce((a, b) => a + b, 0);
}

const RANGE_RE = /\{(\d+)\.\.(\d+)\}/;

/**
 * Expand one brace range so a whole batch can be added at once.
 *
 *   'agent-{1..3}'  -> agent-1, agent-2, agent-3
 *   'node-{01..03}' -> node-01, node-02, node-03  (zero-padding is preserved)
 *
 * Plain names come back unchanged, so the single-machine path is the same code
 * path as the bulk one.
 */
export function expandNames(pattern: string): string[] {
  const m = RANGE_RE.exec(pattern);
  if (!m) return [pattern];
  const [loRaw, hiRaw] = [m[1], m[2]];
  const lo = parseInt(loRaw, 10);
  const hi = parseInt(hiRaw, 10);
  if (hi < lo) {
    throw new ValidationError(`range {${loRaw}..${hiRaw}} counts backwards`);
  }
  if (hi - lo + 1 > MAX_BULK_CREATE) {
    throw new ValidationError(
      `range expands to more than ${MAX_BULK_CREATE} machines`,
    );
  }
  const width = loRaw.startsWith("0") ? loRaw.length : 0;
  const head = pattern.slice(0, m.index);
  const tail = pattern.slice(m.index + m[0].length);
  const out: string[] = [];
  for (let i = lo; i <= hi; i++) {
    out.push(head + (width ? String(i).padStart(width, "0") : String(i)) + tail);
  }
  return out;
}

// Picking the next free port and starting the container is a read-then-write:
// two concurrent creates would otherwise choose the same port and the second
// container would fail to bind. One process now, but `await` still interleaves
// requests, so the section still has to be serialised.
let createChain: Promise<unknown> = Promise.resolve();

function withCreateLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = createChain.then(fn, fn);
  createChain = next.catch(() => {});
  return next;
}

/**
 * Insert + boot a single machine. Throws ValidationError for user-facing
 * problems so the bulk path can report them per-name.
 */
export async function createOneComputer(
  name: string,
  image: string | null,
): Promise<ComputerView> {
  const slug = slugify(name);
  const clash = one("SELECT 1 AS x FROM computers WHERE name = ? OR slug = ?", name, slug);
  if (clash) throw new ValidationError(`'${name}' already exists`);

  const providerName = defaultProviderName();
  const backend = providerByName(providerName);

  await withCreateLock(async () => {
    const reserved = all<{ novnc_port: number }>(
      "SELECT novnc_port FROM computers",
    ).map((r) => r.novnc_port);
    const chosen = await backend.nextNovncPort(reserved);
    const password = randomVncPassword();
    await backend.createComputer(slug, chosen, password, image);
    run(
      "INSERT INTO computers (name, slug, novnc_port, vnc_password, image, provider, created_at) " +
        "VALUES (?,?,?,?,?,?,?)",
      name,
      slug,
      chosen,
      password,
      image,
      providerName,
      nowIso(),
    );
  });

  const row = one<Computer>("SELECT * FROM computers WHERE slug = ?", slug)!;
  return computerView(row, { withState: false });
}

export function touchActive(compId: number): void {
  run("UPDATE computers SET last_active_at = ? WHERE id = ?", nowIso(), compId);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForBridge(
  comp: Computer,
  timeout: number,
): Promise<boolean> {
  const bridge = providerFor(comp).bridgeEndpoint(comp.slug);
  const target = { bridge_host: bridge.host, bridge_port: bridge.port };
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    if (await checkBridge(target)) return true;
    await sleep(1500);
  }
  return false;
}

/**
 * Start a sleeping machine and block until its bridge answers.
 *
 * Callers need the machine actually usable, not merely started: a desktop
 * takes a few seconds to bring up X and the bridge a few more to attach.
 *
 * A container that is started rather than created keeps the filesystem of its
 * previous life, and that is a reliable source of processes which refuse to
 * start twice — stale lock files, sockets, pid files. When the bridge doesn't
 * come back, recreating the pair clears all of it. The home volume survives
 * either way, so the cost is the container's own scratch state.
 */
export async function wakeAndWait(
  comp: Computer,
  timeout?: number,
): Promise<{ ready: boolean; recreated: boolean }> {
  // Read at call time, not from a binding fixed at import: a value captured
  // once then silently ignores anything that changes the setting.
  const limit = timeout ?? envFloat("DESKSWARM_WAKE_TIMEOUT", 45);
  const backend = providerFor(comp);
  await backend.resumeComputer(comp.slug);
  touchActive(comp.id);
  if (await waitForBridge(comp, limit)) {
    return { ready: true, recreated: false };
  }
  try {
    await backend.destroyComputer(comp.slug, true);
    await backend.createComputer(comp.slug, comp.novnc_port, comp.vnc_password, comp.image);
  } catch {
    return { ready: false, recreated: false };
  }
  return { ready: await waitForBridge(comp, limit), recreated: true };
}
