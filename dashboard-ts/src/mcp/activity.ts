/**
 * What the outside clients are doing, right now.
 *
 * The wall used to outline a machine amber when a task was running in it and
 * caption it with the agent's current step. That signal came from a `tasks`
 * row this process wrote itself. Now the work happens in someone else's
 * client, and the only thing deskswarm sees is the calls arriving — so that is
 * what the wall is built on.
 *
 * Two stores, deliberately:
 *
 *   here      a small in-memory ring, for "is anything happening in this
 *             machine in the last minute". Losing it on restart costs a
 *             liveness dot for one minute, which is not worth a write per call.
 *
 *   audit     the durable record — every call, with who, what and the result.
 *             That is what the activity feed reads, and it is written by the
 *             MCP handler through the same audit module as everything else.
 */

import { LIVE_WINDOW_SECONDS } from "./../settings";

export interface Call {
  machine: string;
  tool: string;
  label: string;
  ok: boolean;
  at: number;
}

/** Enough to show a feed while the audit query is the source of truth. A
 *  busy fleet fills this in minutes; that is fine, it is a liveness buffer. */
const RING = 400;
const ring: Call[] = [];

/** machine name -> its most recent call. */
const latest = new Map<string, Call>();

export function note(machine: string, tool: string, label: string, ok: boolean): void {
  const call: Call = { machine, tool, label, ok, at: Date.now() };
  latest.set(machine, call);
  ring.push(call);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
}

export interface LiveEntry {
  tool: string;
  label: string;
  ok: boolean;
  seconds_ago: number;
}

/**
 * Machines touched inside the live window, and what touched them.
 *
 * Keyed by machine name because that is what the templates and the fleet view
 * carry — the slug is an implementation detail of the container names.
 */
export function recentActivity(): Record<string, LiveEntry> {
  const cutoff = Date.now() - LIVE_WINDOW_SECONDS * 1000;
  const out: Record<string, LiveEntry> = {};
  for (const [machine, call] of latest) {
    if (call.at < cutoff) continue;
    out[machine] = {
      tool: call.tool,
      label: call.label,
      ok: call.ok,
      seconds_ago: Math.round((Date.now() - call.at) / 1000),
    };
  }
  return out;
}

/** Just the names, for the idle sweeper. */
export function busyMachines(): Set<string> {
  return new Set(Object.keys(recentActivity()));
}

/** The in-memory tail, newest first. The durable feed comes from the audit
 *  table; this exists for tests and for the moment right after a call when
 *  the audit row may not have been committed yet. */
export function tail(machine?: string | null, limit = 50): Call[] {
  const rows = machine ? ring.filter((c) => c.machine === machine) : ring;
  return rows.slice(-limit).reverse();
}

/** Tests reuse one process across suites; without this, a machine that was
 *  busy in an earlier test is still busy in the next one. */
export function reset(): void {
  ring.length = 0;
  latest.clear();
}
