/**
 * Backing a machine's home up, and putting it back.
 *
 * Only Docker is stubbed here: the streaming, the gzip and the tar sanitising
 * all run for real against a stand-in home, so a round trip that says the bytes
 * came back really means it.
 */
import { beforeEach, expect, test } from "bun:test";
import { gunzipSync, gzipSync } from "node:zlib";
import * as tar from "tar-stream";
import { addMachine, del, get, homes, post, reset, seedHome, states } from "./harness";
import * as backups from "../src/backups";

beforeEach(() => {
  reset();
  delete process.env.DESKSWARM_BACKUP_KEEP;
});

const add = async (name = "m1") => (await addMachine(name)).json.data.id;
const home = (slug: string) => Object.fromEntries(homes.get(slug) ?? []);

test("backup then restore returns the same bytes", async () => {
  const id = await add();
  seedHome("m1", { "Desktop/notes.txt": "مرحبا يا عالم\n", ".config/app.conf": "key=value" });

  const r = await post(`/api/v1/computers/${id}/backups`);
  expect(r.status).toBe(201);
  const name = r.json.data.name;

  seedHome("m1", { "Desktop/notes.txt": "clobbered" });
  expect((await post(`/api/v1/computers/${id}/restore`, { json: { backup: name } })).status).toBe(200);

  expect(Buffer.from(home("m1")["Desktop/notes.txt"]).toString()).toBe("مرحبا يا عالم\n");
  expect(Buffer.from(home("m1")[".config/app.conf"]).toString()).toBe("key=value");
});

test("restore replaces rather than merges", async () => {
  // Anything not in the backup should not survive it — otherwise 'restore'
  // quietly means 'merge' and the machine lands in a state that never was.
  const id = await add();
  seedHome("m1", { "keep.txt": "a" });
  const name = (await post(`/api/v1/computers/${id}/backups`)).json.data.name;

  homes.get("m1")!.set("appeared-later.txt", Buffer.from("b"));
  await post(`/api/v1/computers/${id}/restore`, { json: { backup: name } });

  expect(Object.keys(home("m1"))).toEqual(["keep.txt"]);
});

test("a sleeping machine can be backed up and stays asleep", async () => {
  const id = await add();
  seedHome("m1", { "a.txt": "x" });
  await post(`/api/v1/computers/${id}/sleep`);
  expect((await post(`/api/v1/computers/${id}/backups`)).status).toBe(201);
  expect(states.get("m1")).toBe("exited");
});

test("restore stops a running machine and starts it again", async () => {
  const id = await add();
  seedHome("m1", { "a.txt": "x" });
  const name = (await post(`/api/v1/computers/${id}/backups`)).json.data.name;
  const data = (await post(`/api/v1/computers/${id}/restore`, { json: { backup: name } })).json.data;
  expect(data.restarted).toBe(true);
  expect(states.get("m1") ?? "running").toBe("running");
});

test("old backups are pruned", async () => {
  process.env.DESKSWARM_BACKUP_KEEP = "2";
  const id = await add();
  seedHome("m1", { "a.txt": "x" });

  const names: string[] = [];
  for (let i = 0; i < 4; i++) {
    // The filename is a UTC second, so distinct backups need distinct stamps —
    // otherwise this test measures the clock, not the pruning.
    const meta = await backups.create("m1", new Date(`2026-01-0${i + 1}T00:00:00Z`));
    names.push(meta.name);
  }

  const kept = (await get(`/api/v1/computers/${id}/backups`)).json.data.map((b: any) => b.name);
  expect(kept).toEqual([names[3], names[2]]); // only the newest two
});

test("download and delete", async () => {
  const id = await add();
  seedHome("m1", { "a.txt": "hello" });
  const name = (await post(`/api/v1/computers/${id}/backups`)).json.data.name;

  const r = await get(`/api/v1/computers/${id}/backups/${name}`);
  expect(r.status).toBe(200);
  const names = await tarNames(gunzipSync(r.bytes));
  expect(names).toContain("cua/a.txt");

  expect((await del(`/api/v1/computers/${id}/backups/${name}`)).status).toBe(200);
  expect((await get(`/api/v1/computers/${id}/backups`)).json.data).toEqual([]);
});

for (const name of ["../../../etc/passwd", "..%2f..%2fetc", "a/b", ""]) {
  test(`a backup name cannot escape the directory: ${JSON.stringify(name)}`, async () => {
    const id = await add();
    const r = await get(`/api/v1/computers/${id}/backups/${name}`);
    expect([400, 404]).toContain(r.status);
  });
}

// ------------------------------------------------------- untrusted archives

function makeUpload(
  members: [string, string][],
  links: [string, string][] = [],
): Promise<Buffer> {
  const pack = tar.pack();
  for (const [path, data] of members) {
    pack.entry({ name: path, size: Buffer.byteLength(data) }, Buffer.from(data));
  }
  for (const [path, target] of links) {
    pack.entry({ name: path, type: "symlink", linkname: target, size: 0 });
  }
  pack.finalize();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    pack.on("data", (c: Buffer) => chunks.push(c));
    pack.on("end", () => resolve(gzipSync(Buffer.concat(chunks))));
    pack.on("error", reject);
  });
}

function tarNames(raw: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const names: string[] = [];
    const extract = tar.extract();
    extract.on("entry", (h, s, next) => {
      names.push(h.name);
      s.resume();
      s.on("end", next);
    });
    extract.on("finish", () => resolve(names));
    extract.on("error", reject);
    extract.end(raw);
  });
}

async function upload(id: number, blob: Buffer, filename = "backup.tar.gz") {
  const form = new FormData();
  form.append("file", new File([blob as unknown as BlobPart], filename));
  return post(`/api/v1/computers/${id}/restore/upload`, { body: form });
}

test("an uploaded backup is restored", async () => {
  const id = await add();
  const r = await upload(id, await makeUpload([["cua/from-elsewhere.txt", "hi"]]));
  expect(r.status).toBe(200);
  expect(Buffer.from(home("m1")["from-elsewhere.txt"]).toString()).toBe("hi");
});

test("escaping members are dropped, not written", async () => {
  // An uploaded tar is entirely untrusted input, and '../../etc/cron.d/x' is
  // the oldest trick there is.
  const id = await add();
  const blob = await makeUpload([
    ["cua/ok.txt", "fine"],
    ["../../../etc/cron.d/pwn", "* * * * * root sh -c evil"],
    ["/etc/shadow", "root::"],
    ["cua/../../root/.ssh/authorized_keys", "ssh-rsa AAAA"],
  ]);
  expect((await upload(id, blob)).status).toBe(200);
  expect(Object.keys(home("m1")).sort()).toEqual(["ok.txt"]);
});

test("symlinks pointing outside are dropped", async () => {
  const id = await add();
  const blob = await makeUpload(
    [["cua/ok.txt", "fine"]],
    [["cua/escape", "/etc"], ["cua/escape2", "../../../root"]],
  );
  expect((await upload(id, blob)).status).toBe(200);
  expect(Object.keys(home("m1")).sort()).toEqual(["ok.txt"]);
});

test("a symlink staying inside the home is kept", async () => {
  // The check is about where the link points, not that it is a link —
  // otherwise a restore would quietly drop half of a real home directory.
  const id = await add();
  const blob = await makeUpload(
    [["cua/real.txt", "fine"]],
    [["cua/shortcut", "real.txt"], ["cua/Desktop/up", "../real.txt"]],
  );
  expect((await upload(id, blob)).status).toBe(200);
  expect(Buffer.from(home("m1")["shortcut"]).toString()).toBe("->real.txt");
  expect(Buffer.from(home("m1")["Desktop/up"]).toString()).toBe("->../real.txt");
});

test("a file that is not an archive is refused", async () => {
  const id = await add();
  const r = await upload(id, Buffer.from("this is not a tarball at all"));
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(Object.keys(home("m1"))).toEqual([]);
});

test("restored files belong to the desktop user", async () => {
  // Root-owned files under /home/cua are the exact fault that broke
  // LibreOffice for the desktop session once already.
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const src = join(tmpdir(), `ds-sanitise-src-${process.pid}.tar.gz`);
  const dest = join(tmpdir(), `ds-sanitise-dest-${process.pid}.tar`);
  await Bun.write(src, await makeUpload([["cua/a.txt", "x"]]));

  expect(await backups.sanitise(src, dest)).toBe(1);

  const owners: [number | undefined, number | undefined, string | undefined][] = [];
  await new Promise<void>((resolve, reject) => {
    const extract = tar.extract();
    extract.on("entry", (h, s, next) => {
      owners.push([h.uid, h.gid, h.uname]);
      s.resume();
      s.on("end", next);
    });
    extract.on("finish", () => resolve());
    extract.on("error", reject);
    Bun.file(dest).stream().pipeTo(
      new WritableStream({
        write: (chunk) => void extract.write(Buffer.from(chunk)),
        close: () => {
          extract.end();
        },
      }),
    );
  });
  expect(owners).toEqual([[1000, 1000, "cua"]]);
});
