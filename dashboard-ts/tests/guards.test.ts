/**
 * deskswarm already survives process failures. These guard the quiet ones — a
 * schedule burning money, memory running out a machine at a time, a disk
 * filling with snapshots, or every task failing because the provider is down.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addMachine, get, post, reset } from "./harness";
import { run } from "../src/db";
import { nowIso } from "../src/settings";
import { memoryReport, probes } from "../src/guards";

const realProbes = { ...probes };

beforeEach(() => {
  reset();
  Object.assign(probes, realProbes);
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("DESKSWARM_DAILY_COST") || k.startsWith("DESKSWARM_MEMORY") ||
        k.startsWith("DESKSWARM_MACHINE_MB") || k.startsWith("DESKSWARM_MIN_FREE") ||
        k.startsWith("DESKSWARM_FAILURE") || k.startsWith("DESKSWARM_BREAKER") ||
        k.startsWith("DESKSWARM_LOW_DISK")) delete process.env[k];
  }
});
afterEach(() => Object.assign(probes, realProbes));

const seedTask = (desktop: string, status: string, cost?: number, when?: Date) => {
  const ts = nowIso(when ?? new Date());
  run(
    "INSERT INTO tasks (desktop, description, status, cost_usd, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    desktop, "x", status, cost ?? null, ts, ts,
  );
};

const budget = (mb: number) => {
  process.env.DESKSWARM_MEMORY_BUDGET_MB = String(mb);
  process.env.DESKSWARM_MACHINE_MB = "300";
  process.env.DESKSWARM_MIN_FREE_MB = "512";
};

describe("the cost cap", () => {
  test("is off by default", async () => {
    await addMachine("m1");
    seedTask("m1", "COMPLETED", 999);
    expect((await post("/api/v1/tasks", { json: { description: "x" } })).status).toBe(201);
  });

  test("refuses dispatch once the day is spent", async () => {
    process.env.DESKSWARM_DAILY_COST_LIMIT = "1.0";
    await addMachine("m1");
    seedTask("m1", "COMPLETED", 1.5);
    const r = await post("/api/v1/tasks", { json: { description: "x" } });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("daily cost limit");
  });

  test("lets spending under the cap through", async () => {
    process.env.DESKSWARM_DAILY_COST_LIMIT = "10";
    await addMachine("m1");
    seedTask("m1", "COMPLETED", 0.5);
    expect((await post("/api/v1/tasks", { json: { description: "x" } })).status).toBe(201);
  });

  test("does not count yesterday's spend", async () => {
    process.env.DESKSWARM_DAILY_COST_LIMIT = "1.0";
    await addMachine("m1");
    seedTask("m1", "COMPLETED", 99, new Date(Date.now() - 2 * 86400_000));
    expect((await post("/api/v1/tasks", { json: { description: "x" } })).status).toBe(201);
  });
});

describe("memory admission", () => {
  test("creation is refused when memory is short", async () => {
    budget(600);
    const r = await addMachine("too-many");
    expect(r.status).toBe(507);
    expect(r.json.error).toContain("not enough memory");
  });

  test("a batch is sized as a whole", async () => {
    // Room for one machine is not room for ten.
    budget(1200);
    expect((await addMachine("solo")).status).toBe(201);
    expect((await addMachine("many-{1..10}")).status).toBe(507);
  });

  test("the budget is spent by existing machines", async () => {
    // budget 1500, 300 per machine, 512 must stay free -> a new machine needs
    // 812 MB of headroom.
    budget(1500);
    expect((await addMachine("one")).status).toBe(201);   // 1500 free
    expect((await addMachine("two")).status).toBe(201);   // 1200 free
    expect((await addMachine("three")).status).toBe(201); //  900 free
    expect((await addMachine("four")).status).toBe(507);  //  600 free -> refused
  });

  test("meminfo is used when no budget is set", async () => {
    probes.cgroupLimitMb = () => null;
    probes.meminfoAvailableMb = () => 400;
    process.env.DESKSWARM_MACHINE_MB = "300";
    process.env.DESKSWARM_MIN_FREE_MB = "512";
    const r = await addMachine("tight");
    expect(r.status).toBe(507);
    // and it says why the number may be wrong under a nested cap
    expect(r.json.error).toContain("DESKSWARM_MEMORY_BUDGET_MB");
  });

  test("a nested cap is not silently trusted", () => {
    // Docker inside an LXC reads the *host's* /proc/meminfo — 63 GB on a CT
    // capped at 8 GB — so that reading must be marked untrusted.
    probes.cgroupLimitMb = () => null;
    probes.meminfoAvailableMb = () => 63000;
    expect(memoryReport().trusted).toBe(false);
    expect(memoryReport().source).toBe("meminfo");
  });

  test("an explicit budget is trusted", () => {
    process.env.DESKSWARM_MEMORY_BUDGET_MB = "8192";
    const rep = memoryReport();
    expect(rep.trusted).toBe(true);
    expect(rep.source).toBe("budget");
  });

  test("unknown memory does not block", async () => {
    probes.cgroupLimitMb = () => null;
    probes.meminfoAvailableMb = () => null;
    expect((await addMachine("unknowable")).status).toBe(201);
  });
});

describe("disk", () => {
  test("creation is refused when the disk is nearly full", async () => {
    probes.diskFreeGb = () => 1.0;
    process.env.DESKSWARM_MIN_FREE_DISK_GB = "5";
    const r = await addMachine("nospace");
    expect(r.status).toBe(507);
    expect(r.json.error).toContain("disk left");
  });

  test("snapshots are refused too", async () => {
    // Snapshots are 2-6 GB each and are what actually fills the disk.
    const cid = (await addMachine("src")).json.data.id;
    probes.diskFreeGb = () => 1.0;
    process.env.DESKSWARM_MIN_FREE_DISK_GB = "5";
    expect((await post(`/api/v1/computers/${cid}/snapshot`, { json: { name: "s" } })).status).toBe(507);
  });

  test("low disk warns before it blocks", async () => {
    probes.diskFreeGb = () => 9.0;
    process.env.DESKSWARM_MIN_FREE_DISK_GB = "5";
    process.env.DESKSWARM_LOW_DISK_WARN_GB = "15";
    expect((await addMachine("ok-for-now")).status).toBe(201);
    const warnings = (await get("/api/v1/guards")).json.data.warnings;
    expect(warnings.some((w: string) => w.includes("disk left"))).toBe(true);
  });
});

describe("the failure breaker", () => {
  test("dispatch pauses after a run of failures", async () => {
    process.env.DESKSWARM_FAILURE_BREAKER = "3";
    await addMachine("m1");
    for (let i = 0; i < 3; i++) seedTask("m1", "FAILED");
    const r = await post("/api/v1/tasks", { json: { description: "x" } });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("all failed");
  });

  test("a success in the run clears it", async () => {
    process.env.DESKSWARM_FAILURE_BREAKER = "3";
    await addMachine("m1");
    seedTask("m1", "FAILED");
    seedTask("m1", "FAILED");
    seedTask("m1", "COMPLETED");
    expect((await post("/api/v1/tasks", { json: { description: "x" } })).status).toBe(201);
  });

  test("it reopens after the cooldown", async () => {
    // A breaker that never retries is just an outage of its own.
    process.env.DESKSWARM_FAILURE_BREAKER = "3";
    process.env.DESKSWARM_BREAKER_COOLDOWN_MIN = "10";
    await addMachine("m1");
    const old = new Date(Date.now() - 30 * 60_000);
    for (let i = 0; i < 3; i++) seedTask("m1", "FAILED", undefined, old);
    expect((await post("/api/v1/tasks", { json: { description: "x" } })).status).toBe(201);
  });
});

test("the status endpoint reports everything", async () => {
  const d = (await get("/api/v1/guards")).json.data;
  for (const key of ["spend_today_usd", "memory_available_mb", "disk_free_gb",
                     "consecutive_failures", "blocking", "warnings", "ok"]) {
    expect(d).toHaveProperty(key);
  }
});
