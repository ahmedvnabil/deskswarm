import { beforeEach, afterEach, expect, test } from "bun:test";
import { reset, get, post } from "./harness";
import { cfTransport } from "../src/cloudflare/control";
import { defaults } from "../src/cloudflare/preparation";
import { run } from "../src/db";
import { artifactManifest } from "../src/agents/artifacts";
const original = cfTransport.fetch;
let calls = 0;
beforeEach(() => {
  reset();
  calls = 0;
  cfTransport.fetch = async () => {
    calls++;
    throw Error("No provider calls permitted");
  };
});
afterEach(() => {
  cfTransport.fetch = original;
});
test("preparation persists validated preferences with no external mutations or tokens", async () => {
  const first = await get("/api/v1/cloudflare/preparation");
  expect(first.json.data.remote_verified).toBe(false);
  const saved = await post("/api/v1/cloudflare/preparation", {
    json: {
      ...defaults,
      selected: ["containers", "artifacts"],
      token: "must-never-persist",
      retention_days: 45,
    },
  });
  expect(saved.status).toBe(200);
  expect(saved.text).not.toContain("must-never-persist");
  expect(
    (await get("/api/v1/cloudflare/preparation")).json.data.settings
      .retention_days,
  ).toBe(45);
  expect(calls).toBe(0);
});
test("cannot activate a cloud default or accept invalid limits and resource names", async () => {
  for (const changes of [
    { default_target: "cloudflare" },
    { max_machines: 100 },
    { selected: ["unknown"] },
    { artifact_prefix: "../secrets" },
    { worker_name: "https://evil.test" },
    { retention_days: 0 },
  ])
    expect(
      (
        await post("/api/v1/cloudflare/preparation", {
          json: { ...defaults, ...changes },
        })
      ).status,
    ).toBe(400);
  expect(calls).toBe(0);
});
test("configuration export is removed and defaults stay local",async()=>{
 expect((await get("/api/v1/cloudflare/preparation/bundle")).status).toBe(404);
 expect((await get("/api/v1/cloudflare/preparation",{noCookie:true})).status).toBe(401);
 expect((await get("/api/v1/cloudflare/preparation")).json.data.remote_verified).toBe(false);
 expect(calls).toBe(0);
});
test("artifact integrity describes real bytes and marks partial output without host paths", () => {
  const m = artifactManifest(
    { id: 7, status: "stopped", created_at: "today" },
    [{ id: 1, name: "report.txt", data: Buffer.from("abc") }],
  );
  expect(m.partial).toBe(true);
  expect(m.files[0].bytes).toBe(3);
  expect(m.files[0].sha256).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(m.files[0].archive_path).toBe("files/1-report.txt");
  expect(JSON.stringify(m)).not.toContain("disk_name");
});

test("suggestions use the configured worker while saved names remain unchanged",async()=>{
 await get("/api/v1/cloudflare/preparation");
 run("INSERT INTO cloudflare_config VALUES(1,?,?,?,?,?,?)", "a".repeat(32),"myteam-control","https://example.com","test-secret","test-edge","today");
 const first=(await get("/api/v1/cloudflare/preparation")).json.data.settings;
 expect(first.worker_name).toBe("myteam-compute");
 expect(first.bucket_name).toBe("myteam-artifacts");
 await post("/api/v1/cloudflare/preparation",{json:{...first,worker_name:"custom-compute"}});
 run("UPDATE cloudflare_config SET worker=? WHERE id=1","different-control");
 expect((await get("/api/v1/cloudflare/preparation")).json.data.settings.worker_name).toBe("custom-compute");
 expect(calls).toBe(0);
});
