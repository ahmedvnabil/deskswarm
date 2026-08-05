/**
 * Fail tasks whose runner died with a previous dashboard process.
 *
 * A task is driven by a subprocess owned by the dashboard. If the container
 * restarts mid-task, nothing survives to finish it, but the row stays RUNNING
 * for ever: the machine shows busy on the wall, "0 running" is wrong, and the
 * task never resolves.
 *
 * Runs once per start, before the server accepts anything.
 */

import { existsSync } from "node:fs";
import { getDb, run } from "./db";
import { DB_PATH, nowIso } from "./settings";

export function reclaim(): number {
  const path = process.env.DESKSWARM_DB_PATH || DB_PATH;
  if (!existsSync(path)) return 0;
  try {
    getDb().query("SELECT 1 FROM tasks LIMIT 1").get();
  } catch {
    return 0; // first boot, no schema yet
  }
  const { changes } = run(
    "UPDATE tasks SET status = 'FAILED', pid = NULL, current_action = NULL, " +
      "error = 'interrupted — the dashboard restarted while this task was running', " +
      "updated_at = ? WHERE status IN ('PENDING', 'RUNNING')",
    nowIso(),
  );
  if (changes) {
    console.log(`[reclaim] failed ${changes} task(s) orphaned by a restart`);
  }
  return changes;
}
