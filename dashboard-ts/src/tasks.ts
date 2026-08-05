/**
 * Task rows, the worker that runs one, dispatch, and the analytics over them.
 *
 * The worker still shells out to run_task.py: the cua agent loop it drives has
 * no published TypeScript equivalent, and a subprocess per task was already
 * the design — one clean process per agent session, killable by pid.
 */

import { all, one, run } from "./db";
import * as fleet from "./fleet";
import * as guards from "./guards";
import { listComputers, wakeAndWait, type Computer } from "./machines";
import {
  MAX_CONCURRENT_TASKS,
  PYTHON,
  RUN_TASK_SCRIPT,
  TASK_TIMEOUT_SECONDS,
  nowIso,
  parseIso,
} from "./settings";

export class ValidationError extends Error {}

/** Task ids dispatch decided to start. Only populated when workers are
 *  disabled, which is the test configuration. */
export const dispatched: number[] = [];

export interface TaskRow {
  id: number;
  desktop: string;
  description: string;
  status: string;
  current_action: string | null;
  result_text: string | null;
  actions: string | null;
  cost_usd: number | null;
  error: string | null;
  pid: number | null;
  started_at: string | null;
  created_at: string;
  updated_at: string;
  duration_seconds?: number | null;
}

export function createTaskRow(desktop: string, description: string): number {
  const ts = nowIso();
  return run(
    "INSERT INTO tasks (desktop, description, status, created_at, updated_at) " +
      "VALUES (?, ?, 'PENDING', ?, ?)",
    desktop,
    description,
    ts,
    ts,
  ).lastInsertRowid;
}

export function updateTaskRow(taskId: number, fields: Record<string, unknown>): void {
  const patch: Record<string, unknown> = { ...fields, updated_at: nowIso() };
  const keys = Object.keys(patch);
  run(
    `UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    ...keys.map((k) => patch[k]),
    taskId,
  );
}

export const getTaskRow = (taskId: number): TaskRow | null =>
  one<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId);

// A task costs a subprocess plus an agent session. Without a ceiling, "run on
// the whole fleet" across a large fleet would start them all at once. The row
// stays PENDING and visible while it waits, so a fleet-wide dispatch drains
// instead of stampeding.
let inFlight = 0;
const waiting: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT_TASKS) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight += 1;
}

function releaseSlot(): void {
  inFlight -= 1;
  waiting.shift()?.();
}

export async function runTaskWorker(
  taskId: number,
  bridgeHost: string,
  bridgePort: number,
  description: string,
): Promise<void> {
  await acquireSlot();
  try {
    await runOne(taskId, bridgeHost, bridgePort, description);
  } finally {
    releaseSlot();
  }
}

async function runOne(
  taskId: number,
  bridgeHost: string,
  bridgePort: number,
  description: string,
): Promise<void> {
  if (getTaskRow(taskId)?.status === "CANCELLED") return; // cancelled while queued

  updateTaskRow(taskId, {
    status: "RUNNING",
    started_at: nowIso(),
    current_action: "starting",
  });

  try {
    const proc = Bun.spawn(
      [PYTHON, RUN_TASK_SCRIPT, String(taskId), bridgeHost, String(bridgePort), description],
      { stdout: "pipe", stderr: "pipe", env: process.env },
    );
    updateTaskRow(taskId, { pid: proc.pid });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, TASK_TIMEOUT_SECONDS * 1000);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(timer);

    if (timedOut) {
      updateTaskRow(taskId, {
        status: "FAILED",
        pid: null,
        current_action: null,
        error: `timed out after ${TASK_TIMEOUT_SECONDS}s`,
      });
      return;
    }

    if (getTaskRow(taskId)?.status === "CANCELLED") return;

    // The worker prints progress lines too; the last JSON object is the result.
    let lastLine: string | null = null;
    for (const raw of stdout.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("{")) lastLine = line;
    }
    if (lastLine === null) {
      updateTaskRow(taskId, {
        status: "FAILED",
        pid: null,
        current_action: null,
        error: (stderr || "no output").slice(-2000),
      });
      return;
    }
    const payload = JSON.parse(lastLine);
    updateTaskRow(taskId, {
      status: "COMPLETED",
      pid: null,
      current_action: null,
      result_text: payload.final_text ?? null,
      actions: JSON.stringify(payload.actions ?? []),
      cost_usd: payload.cost_usd ?? null,
    });
  } catch (err: any) {
    updateTaskRow(taskId, {
      status: "FAILED",
      pid: null,
      current_action: null,
      error: String(err?.message ?? err).slice(-2000),
    });
  }
}

export function computeDurationSeconds(row: Partial<TaskRow>): number | null {
  const start = parseIso(row.started_at);
  const end = parseIso(row.updated_at);
  if (!start || !end) return null;
  if (row.status === "PENDING" || row.status === "RUNNING") return null;
  return Math.round(((end.getTime() - start.getTime()) / 1000) * 10) / 10;
}

export function buildAnalytics() {
  const rows = all<TaskRow>("SELECT * FROM tasks");
  const byStatus: Record<string, number> = {
    PENDING: 0,
    RUNNING: 0,
    COMPLETED: 0,
    FAILED: 0,
    CANCELLED: 0,
  };
  let totalCost = 0;
  const durations: number[] = [];
  const perDesktop = new Map<
    string,
    { name: string; total: number; completed: number; failed: number; cost_usd: number; exists?: boolean }
  >();

  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.cost_usd) totalCost += r.cost_usd;
    const d = computeDurationSeconds(r);
    if (d !== null) durations.push(d);

    let pd = perDesktop.get(r.desktop);
    if (!pd) {
      pd = { name: r.desktop, total: 0, completed: 0, failed: 0, cost_usd: 0 };
      perDesktop.set(r.desktop, pd);
    }
    pd.total += 1;
    if (r.status === "COMPLETED") pd.completed += 1;
    else if (r.status === "FAILED") pd.failed += 1;
    if (r.cost_usd) pd.cost_usd += r.cost_usd;
  }

  const liveNames = new Set(listComputers().map((c) => c.name));
  for (const pd of perDesktop.values()) pd.exists = liveNames.has(pd.name);

  const finished = byStatus.COMPLETED + byStatus.FAILED;
  const daily = all<{ day: string; n: number; cost: number }>(
    `SELECT date(updated_at) AS day, COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost
     FROM tasks WHERE status IN ('COMPLETED','FAILED')
     GROUP BY day ORDER BY day DESC LIMIT 14`,
  );

  const round = (n: number, p: number) => Math.round(n * 10 ** p) / 10 ** p;

  return {
    total: rows.length,
    by_status: byStatus,
    success_rate: finished ? round((100 * byStatus.COMPLETED) / finished, 1) : null,
    total_cost_usd: round(totalCost, 4),
    avg_duration_seconds: durations.length
      ? round(durations.reduce((a, b) => a + b, 0) / durations.length, 1)
      : null,
    per_desktop: [...perDesktop.values()].sort((a, b) => {
      if (a.exists !== b.exists) return a.exists ? -1 : 1;
      return a.name.localeCompare(b.name);
    }),
    daily: daily
      .map((r) => ({ day: r.day, count: r.n, cost: round(r.cost, 4) }))
      .reverse(),
  };
}

/** Newest in-flight task per computer name, so a card can show what its agent
 *  is doing right now instead of just whether the bridge is up. */
export function activeTaskByComputer(): Record<string, TaskRow> {
  const rows = all<TaskRow>(
    "SELECT id, desktop, description, status, current_action FROM tasks " +
      "WHERE status IN ('PENDING', 'RUNNING') ORDER BY id DESC",
  );
  const busy: Record<string, TaskRow> = {};
  for (const r of rows) if (!(r.desktop in busy)) busy[r.desktop] = r;
  return busy;
}

/**
 * Queue `description` on one computer or the whole fleet.
 *
 * Shared by the tasks API and the scheduler so both behave identically.
 * Throws ValidationError for anything the caller should report as a 400.
 */
export function dispatchTask(target: string, description: string): number[] {
  for (const [ok, msg] of [guards.checkCost(), guards.checkBreaker()]) {
    if (!ok) throw new ValidationError(msg);
  }

  const computers = listComputers();
  if (!computers.length) {
    throw new ValidationError("no computers in the fleet — add one first");
  }

  let targets: Computer[];
  if (target === "all") {
    // "Whole fleet" means every machine an agent is allowed to touch. A
    // reserved machine is one you are working on by hand, so a broadcast must
    // not grab its keyboard out from under you. Naming it explicitly still
    // works — that is a deliberate choice rather than a side effect.
    targets = computers.filter((c) => !c.reserved);
    if (!targets.length) {
      throw new ValidationError(
        "every machine is reserved — un-reserve one, or name a target",
      );
    }
  } else {
    targets = computers.filter((c) => c.name === target);
    if (!targets.length) throw new ValidationError(`unknown computer '${target}'`);
  }

  const createdIds: number[] = [];
  for (const comp of targets) {
    const taskId = createTaskRow(comp.name, description);
    createdIds.push(taskId);
    startTask(comp, taskId, description);
  }
  return createdIds;
}

/**
 * Run one task in the background, waking the machine first if it is asleep.
 *
 * Waking takes seconds, so it belongs here rather than in dispatchTask — the
 * HTTP request that queued the task should not sit and wait for a desktop to
 * boot. A schedule naming a sleeping machine works instead of failing against
 * a stopped bridge.
 */
export function startTask(comp: Computer, taskId: number, description: string): void {
  started = (async () => {
    try {
      const state = await fleet.containerState(comp.slug);
      if (state.desktop_state === "exited") await wakeAndWait(comp);
    } catch {
      /* best effort — the worker reports the real failure */
    }
    // The same seam DESKSWARM_DISABLE_SCHEDULER gives the background loop, and
    // it stops at the agent subprocess rather than before the wake: a real
    // worker would outlive the test and go looking for a database that has
    // been deleted, but everything up to it is what the test is here for.
    if (process.env.DESKSWARM_DISABLE_WORKERS) {
      dispatched.push(taskId);
      return;
    }
    await runTaskWorker(taskId, fleet.bridgeContainerName(comp.slug), 8000, description);
  })();
  void started;
}

/** The most recent dispatch, so a test can await the wake it performs. */
let started: Promise<void> = Promise.resolve();
export const lastStarted = () => started;
