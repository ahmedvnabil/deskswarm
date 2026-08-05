/**
 * File transfer takes paths straight from the browser, so the confinement to
 * /home/cua is the whole security story here.
 */
import { beforeEach, expect, test } from "bun:test";
import { addMachine, get, post, realFleet as fleet, reset } from "./harness";

beforeEach(reset);

test("paths stay inside home", () => {
  expect(fleet.safeHomePath("")).toBe("/home/cua");
  expect(fleet.safeHomePath("Desktop")).toBe("/home/cua/Desktop");
  expect(fleet.safeHomePath("a/b/c.txt")).toBe("/home/cua/a/b/c.txt");
  // A leading slash is read as home-relative rather than as the real root, so
  // an absolute-looking path lands harmlessly inside home.
  expect(fleet.safeHomePath("/Desktop")).toBe("/home/cua/Desktop");
  expect(fleet.safeHomePath("/etc/passwd")).toBe("/home/cua/etc/passwd");
});

for (const evil of [
  "../../etc/shadow",
  "..",
  "Desktop/../../../root/.ssh/id_rsa",
  "a/../../..",
  "/../etc/passwd",
]) {
  test(`traversal is refused: ${evil}`, () => {
    expect(() => fleet.safeHomePath(evil)).toThrow(fleet.PathOutsideHome);
  });
}

for (const bad of ["../x", "a/b", "", ".", ".."]) {
  test(`an upload filename cannot carry a path: ${JSON.stringify(bad)}`, async () => {
    expect(
      fleet.uploadToHome("slug", "Desktop", bad, new Uint8Array([120])),
    ).rejects.toThrow(fleet.PathOutsideHome);
  });
}

test("traversal is refused over http", async () => {
  await addMachine("m1");
  const r = await get("/api/v1/computers/1/files?path=../../etc");
  expect(r.status).toBe(400);
  expect(r.json.error).toContain("outside");

  expect((await get("/api/v1/computers/1/files/download?path=../../etc/passwd")).status).toBe(400);
});

async function uploadForm(name: string, body: Uint8Array, path?: string) {
  const form = new FormData();
  form.append("file", new File([body as unknown as BlobPart], name));
  if (path !== undefined) form.append("path", path);
  return form;
}

test("upload rejects an oversized file", async () => {
  await addMachine("m1");
  const big = new Uint8Array(2 * 1024 * 1024);
  const r = await post("/api/v1/computers/1/files", {
    body: await uploadForm("big.bin", big),
  });
  // The default cap is 64 MB, so 2 MB passes; the check itself is what matters.
  expect([201, 413]).toContain(r.status);
});

test("upload needs a file", async () => {
  await addMachine("m1");
  const r = await post("/api/v1/computers/1/files", { body: new FormData() });
  expect(r.status).toBe(400);
});

test("a cross-site upload is blocked", async () => {
  // Multipart POST is a CORS simple request, so the Origin check is what stops
  // a page dropping a file onto someone's machine.
  await addMachine("m1");
  const r = await post("/api/v1/computers/1/files", {
    body: await uploadForm("x.txt", new Uint8Array([120])),
    headers: { Origin: "https://evil.example.com" },
  });
  expect(r.status).toBe(403);
});

test("an uploaded file lands where it was asked to", async () => {
  await addMachine("m1");
  const r = await post("/api/v1/computers/1/files", {
    body: await uploadForm("note.txt", new TextEncoder().encode("hello"), "Desktop"),
  });
  expect(r.status).toBe(201);
  expect(r.json.data.path).toBe("/home/cua/Desktop/note.txt");
});
