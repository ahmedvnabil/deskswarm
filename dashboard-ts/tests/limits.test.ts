/**
 * Per-machine resource caps, and what happens when the host refuses them.
 *
 * Nested Docker — a Proxmox LXC, an unprivileged runner — may not have the
 * cgroup controllers delegated. Refusing to start the machine there would be a
 * worse outcome than running it uncapped, so the fallback is the interesting
 * half of this.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import { realFleet as fleet } from "./harness";

interface Call {
  HostConfig?: Record<string, unknown>;
  [k: string]: unknown;
}

const calls: Call[] = [];
let refuseOn: string[] = [];
/** An error the fake raises for every call, whatever the limits. */
let alwaysThrow: string | null = null;

/** Docker, reduced to the two calls createContainer + start make. */
mock.module("../src/providers/docker-engine", () => ({
  docker: () => ({
    createContainer: async (spec: Call) => {
      calls.push(spec);
      if (alwaysThrow) throw new Error(alwaysThrow);
      for (const key of refuseOn) {
        if (spec.HostConfig && key in spec.HostConfig) {
          throw Object.assign(
            new Error("OCI runtime create failed: cgroup memory limit not supported"),
            { statusCode: 500 },
          );
        }
      }
      return { start: async () => {} };
    },
    getContainer: () => ({ remove: async () => {} }),
  }),
  isNotFound: (e: any) => e?.statusCode === 404,
  execInContainer: async () => ({ exit_code: 0, output: "" }),
  collect: async () => Buffer.alloc(0),
  bufferStream: () => null,
}));

beforeEach(() => {
  calls.length = 0;
  refuseOn = [];
  alwaysThrow = null;
  fleet.resetLimitsProbe();
});

test("limits are applied", async () => {
  await fleet.runContainer({ name: "x", Image: "img" }, fleet.resourceLimits("2g"));
  expect(calls[0].HostConfig!.Memory).toBe(2 * 1024 ** 3);
  expect(calls[0].HostConfig!.NanoCpus).toBe(2e9);
  expect(calls[0].HostConfig!.PidsLimit).toBe(512);
  expect(fleet.limitsSupportedProbe()).toBe(true);
});

test("a zeroed setting drops out", () => {
  process.env.DESKSWARM_MACHINE_CPUS = "0";
  // The module read these at import, so this asserts the shape rather than
  // re-reading the environment: an empty memory string yields no Memory key.
  expect(fleet.resourceLimits("").Memory).toBeUndefined();
  expect(fleet.resourceLimits("1g").Memory).toBe(1024 ** 3);
  delete process.env.DESKSWARM_MACHINE_CPUS;
});

test("an unsupported host falls back to no limits", async () => {
  refuseOn = ["Memory"];
  await fleet.runContainer({ name: "x", Image: "img" }, fleet.resourceLimits("2g"));
  expect(calls.length).toBe(2); // should retry once, uncapped
  expect(calls[1].HostConfig?.Memory).toBeUndefined();
  expect(fleet.limitsSupportedProbe()).toBe(false);
});

test("the host is only asked once", async () => {
  refuseOn = ["Memory"];
  for (let i = 0; i < 3; i++) {
    await fleet.runContainer({ name: "x", Image: "img" }, fleet.resourceLimits("2g"));
  }
  // First call probes and retries (2); the rest skip straight to uncapped.
  expect(calls.length).toBe(4);
});

test("unrelated docker errors still raise", async () => {
  // "name already in use" is a real conflict, not a host that cannot do
  // cgroups — swallowing it would hide a genuine failure behind a silent retry.
  alwaysThrow = "Conflict: name already in use";
  expect(
    fleet.runContainer({ name: "x", Image: "img" }, fleet.resourceLimits("2g")),
  ).rejects.toThrow("already in use");
});

test("the watchers script ignores the bridge's own connection", () => {
  // 5901 is held open by the bridge forever; counting it would make every
  // machine look permanently in use and defeat the idle sweep.
  expect(fleet.VNC_WATCHERS_SCRIPT).toContain("1AF5");     // 6901, the browser
  expect(fleet.VNC_WATCHERS_SCRIPT).not.toContain("170D"); // 5901, the bridge
});
