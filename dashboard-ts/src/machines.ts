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
  provider: string;
  id: number;
  name: string;
  slug: string;
  novnc_port: number;
  novnc_url: string;
  vnc_password: string;
  created_at: string;
  reserved: boolean;
  no_suspend: boolean;
  last_active_at: string | null;
  control_ok: boolean;
  sleeping: boolean;
  desktop_state?: string;
  error?: string;
  activity?: unknown;
  /** Keys that can reach this machine right now. Zero means no client can. */
  keys_live?: number;
}

export async function computerView(
  comp: Computer,
  opts: { withState?: boolean; host?: string | null } = {},
): Promise<ComputerView> {
  const withState = opts.withState !== false;
  const backend = providerFor(comp);
  const view: ComputerView = {
    provider: backend.name,
    id: comp.id,
    name: comp.name,
    slug: comp.slug,
    novnc_port: comp.novnc_port,
    novnc_url: backend.novncUrl(comp.novnc_port, comp.vnc_password, opts.host),
    vnc_password: comp.vnc_password,
    created_at: comp.created_at,
    reserved: !!comp.reserved,
    no_suspend: !!comp.no_suspend,
    last_active_at: comp.last_active_at,
    control_ok: false,
    sleeping: false,
  };
  if (withState) {
    try {
      Object.assign(view, await backend.containerState(comp.slug));
    } catch (err: any) {
      view.error = String(err?.message ?? err);
    }
    view.sleeping = view.desktop_state === "exited";
    // Probing a stopped Driver just burns the full control timeout, once per
    // machine per refresh — on a wall of sleeping machines that alone made the
    // page slower than its own poll interval.
    if (view.desktop_state === "running") {
      view.control_ok = await checkControl(view);
    }
  }
  return view;
}

export async function checkControl(view: { slug: string; provider?: string | null }): Promise<boolean> {
  const { controlReady } = await import("./control");
  return controlReady(view);
}

/**
 * Build the view for every machine at once.
 *
 * Each machine costs a Docker inspect plus a native Driver probe. Done serially
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

async function waitForControl(
  comp: Computer,
  timeout: number,
): Promise<boolean> {
  const target = { slug: comp.slug, provider: comp.provider };
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    if (await checkControl(target)) return true;
    await sleep(1500);
  }
  return false;
}

/**
 * Start a sleeping machine and block until its Driver answers.
 *
 * Callers need the machine actually usable, not merely started: a desktop
 * takes a few seconds to bring up X and the Driver a few more to attach.
 *
 * A container that is started rather than created keeps the filesystem of its
 * previous life, and that is a reliable source of processes which refuse to
 * start twice — stale lock files, sockets, pid files. When the Driver doesn't
 * come back, recreating the container clears all of it. The home volume survives
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
  if (await waitForControl(comp, limit)) {
    return { ready: true, recreated: false };
  }
  try {
    await backend.destroyComputer(comp.slug, true);
    await backend.createComputer(comp.slug, comp.novnc_port, comp.vnc_password, comp.image);
  } catch {
    return { ready: false, recreated: false };
  }
  return { ready: await waitForControl(comp, limit), recreated: true };
}
