/**
 * The machine-provider abstraction.
 *
 * Two things are worth pinning: that a backend cannot half-implement the
 * interface, and that a row written before the column existed still resolves
 * to something — an existing database is full of those, and getting it wrong
 * would mean a fleet nobody can drive.
 */
import { beforeEach, expect, test } from "bun:test";
import { addMachine, get, realFleet, reset } from "./harness";
import { all, one, run } from "../src/db";
import {
  defaultProviderName,
  providerByName,
  providerFor,
  providerForSlug,
  providerNames,
} from "../src/providers";

beforeEach(() => {
  reset();
  delete process.env.DESKSWARM_PROVIDER;
});

/** Every method MachineProvider declares. Written out rather than derived, so
 *  that adding one to the interface fails here until a backend grows it. */
const REQUIRED = [
  "createComputer", "destroyComputer", "containerState", "suspendComputer",
  "resumeComputer", "isRunning", "bridgeEndpoint", "novncUrl", "nextNovncPort",
  "awakeMachineCount", "vncWatchers", "homeSizeMb", "snapshotComputer",
  "removeImage", "execInDesktopResult", "getInventory", "getClipboard",
  "setClipboard", "pasteText", "listHome", "uploadToHome", "downloadFromHome",
  "homeArchiveStream", "restoreHome",
] as const;

test("the docker provider implements every method", () => {
  const missing = REQUIRED.filter(
    (m) => typeof (realFleet.dockerProvider as any)[m] !== "function",
  );
  expect(missing).toEqual([]);
  expect(realFleet.dockerProvider.name).toBe("docker");
});

test("the registry knows docker and nothing it cannot serve", () => {
  expect(providerNames()).toContain("docker");
  expect(defaultProviderName()).toBe("docker");
  expect(providerByName("docker").name).toBe("docker");
});

test("an unknown provider is an error naming what is available", () => {
  // A row pointing at a backend this build does not have means machines nobody
  // can reach; driving them with the wrong one would be worse than failing.
  expect(() => providerByName("lume")).toThrow("unknown machine provider 'lume'");
  expect(() => providerByName("lume")).toThrow("have: docker");
});

test("a machine created now records its backend", async () => {
  await addMachine("alpha");
  const row = one<{ provider: string }>("SELECT provider FROM computers WHERE name = ?", "alpha");
  expect(row?.provider).toBe("docker");
});

test("a row written without a backend gets one", () => {
  // Which is what an existing database looks like after the migration: the
  // column is NOT NULL with a default, so every machine that predates it is
  // backfilled as docker rather than left ambiguous.
  run(
    "INSERT INTO computers (name, slug, novnc_port, vnc_password, created_at) " +
      "VALUES ('legacy','legacy',6901,'pw','2026-01-01T00:00:00+00:00')",
  );
  const comp = one<any>("SELECT * FROM computers WHERE slug = 'legacy'")!;
  expect(comp.provider).toBe("docker");
  expect(providerFor(comp).name).toBe("docker");
  expect(providerForSlug("legacy").name).toBe("docker");
});

test("the column refuses a machine with no backend at all", () => {
  expect(() =>
    run(
      "INSERT INTO computers (name, slug, novnc_port, vnc_password, provider, created_at) " +
        "VALUES ('nulled','nulled',6902,'pw',NULL,'2026-01-01T00:00:00+00:00')",
    ),
  ).toThrow("NOT NULL");
});

test("a caller with no name in hand gets the default", () => {
  // providerFor is handed rows from several places; one of them one day will
  // not have selected the column.
  expect(providerFor({}).name).toBe("docker");
});

test("a slug nobody knows falls back to the default rather than throwing", () => {
  // Backups are addressed by slug and outlive the machine they came from.
  expect(providerForSlug("deleted-machine").name).toBe("docker");
});

test("the bridge address comes from the backend, not from a name template", async () => {
  await addMachine("alpha");
  const view = (await get("/api/v1/computers")).json.data[0];
  const endpoint = realFleet.dockerProvider.bridgeEndpoint("alpha");
  expect(view.bridge_host).toBe(endpoint.host);
  expect(view.bridge_port).toBe(endpoint.port);
  expect(endpoint.port).toBe(8000);
});

test("a snapshot records the backend whose store holds the image", async () => {
  const id = (await addMachine("src")).json.data.id;
  const { post } = await import("./harness");
  expect((await post(`/api/v1/computers/${id}/snapshot`, { json: { name: "snap" } })).status).toBe(201);
  const rows = all<{ provider: string }>("SELECT provider FROM snapshots");
  expect(rows.map((r) => r.provider)).toEqual(["docker"]);
});
