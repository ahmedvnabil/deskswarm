import { beforeEach, expect, test } from "bun:test";
import { reset } from "./harness";
import { all, run } from "../src/db";
import { nowIso } from "../src/settings";
import { reclaim } from "../src/reclaim";

beforeEach(reset);

test("orphaned tasks are failed on restart", () => {
  // A task is driven by a subprocess owned by the dashboard. If the container
  // restarts mid-task nothing finishes it, and the row used to stay RUNNING
  // for ever — the machine showed busy on the wall and the task never resolved.
  const ts = nowIso();
  for (const [desktop, status, pid] of [
    ["m1", "RUNNING", 8214],
    ["m2", "PENDING", null],
    ["m3", "COMPLETED", null],
  ] as const) {
    run(
      "INSERT INTO tasks (desktop, description, status, pid, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      desktop, "a", status, pid, ts, ts,
    );
  }

  expect(reclaim()).toBe(2);

  const rows = Object.fromEntries(
    all<{ desktop: string; status: string; error: string | null }>(
      "SELECT desktop, status, error FROM tasks",
    ).map((r) => [r.desktop, r]),
  );
  expect(rows.m1.status).toBe("FAILED");
  expect(rows.m1.error).toContain("restarted");
  expect(rows.m2.status).toBe("FAILED");
  expect(rows.m3.status).toBe("COMPLETED"); // finished work is untouched
});

test("reclaim is safe on a fresh install", () => {
  // No rows, no schema surprises, no throw.
  expect(reclaim()).toBe(0);
});
