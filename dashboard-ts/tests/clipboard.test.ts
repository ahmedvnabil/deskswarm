/**
 * Copy/paste across the VNC boundary.
 *
 * The encoding cases are the point: the clipboard is where non-Latin text and
 * shell metacharacters go to break, and both travel base64-encoded precisely
 * so they don't.
 */
import { beforeEach, expect, test } from "bun:test";
import { addMachine, get, pasted, post, reset } from "./harness";
import { MAX_CLIPBOARD_KB } from "../src/settings";

const ARABIC = "مرحبا يا عالم";

beforeEach(reset);

const add = async (name = "m1") => (await addMachine(name)).json.data.id;

test("set then get round-trips", async () => {
  const id = await add();
  expect((await post(`/api/v1/computers/${id}/clipboard`, { json: { text: "hello" } })).status).toBe(200);
  expect((await get(`/api/v1/computers/${id}/clipboard`)).json.data.text).toBe("hello");
});

for (const text of [
  ARABIC,
  "emoji ✅ and — dashes",
  "quotes ' \" and $(echo pwned) `backticks`",
  "line one\nline two\ttabbed",
]) {
  test(`awkward text survives intact: ${JSON.stringify(text).slice(0, 30)}`, async () => {
    const id = await add();
    await post(`/api/v1/computers/${id}/clipboard`, { json: { text } });
    expect((await get(`/api/v1/computers/${id}/clipboard`)).json.data.text).toBe(text);
  });
}

test("the byte count is utf-8, not characters", async () => {
  // Arabic is two bytes a letter; a character count would under-report it.
  const id = await add();
  const r = await post(`/api/v1/computers/${id}/clipboard`, { json: { text: ARABIC } });
  expect(r.json.data.bytes).toBe(Buffer.byteLength(ARABIC, "utf8"));
});

test("the paste flag presses Ctrl+V", async () => {
  const id = await add();
  const r = await post(`/api/v1/computers/${id}/clipboard`, { json: { text: ARABIC, paste: "1" } });
  expect(r.json.data.pasted).toBe(true);
  expect(pasted).toEqual([["m1", ARABIC]]);
});

test("without the flag nothing is typed", async () => {
  const id = await add();
  await post(`/api/v1/computers/${id}/clipboard`, { json: { text: "x" } });
  expect(pasted).toEqual([]);
});

test("an empty string is allowed but missing text is not", async () => {
  const id = await add();
  expect((await post(`/api/v1/computers/${id}/clipboard`, { json: { text: "" } })).status).toBe(200);
  const r = await post(`/api/v1/computers/${id}/clipboard`, { json: {} });
  expect(r.status).toBe(400);
  expect(r.json.error).toContain("text is required");
});

test("an oversized clipboard is refused", async () => {
  const id = await add();
  const huge = "a".repeat(MAX_CLIPBOARD_KB * 1024 + 1);
  expect((await post(`/api/v1/computers/${id}/clipboard`, { json: { text: huge } })).status).toBe(413);
});

test("an unknown machine is a 404", async () => {
  expect((await get("/api/v1/computers/999/clipboard")).status).toBe(404);
  expect((await post("/api/v1/computers/999/clipboard", { json: { text: "x" } })).status).toBe(404);
});

test("a cross-site write is blocked", async () => {
  // Writing the clipboard then pressing Ctrl+V is remote code execution by
  // another name — a page on another origin must not reach it.
  const id = await add();
  const r = await post(`/api/v1/computers/${id}/clipboard`, {
    json: { text: "rm -rf /", paste: "1" },
    headers: { Origin: "http://evil.example" },
  });
  expect(r.status).toBe(403);
  expect(pasted).toEqual([]);
});
