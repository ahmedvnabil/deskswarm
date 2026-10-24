import { expect, test } from "bun:test";
import { decodeDriverScreenshot, translateCommand } from "../src/driver";

test("maps desktop input and refuses unsupported commands", () => {
  expect(
    translateCommand("click", { x: 1, y: 2, button: "left", count: 1 }).args,
  ).toMatchObject({ scope: "desktop", x: 1, y: 2, button: "left" });
  expect(translateCommand("hotkey", { keys: ["Tab"] }).tool).toBe("press_key");
  expect(() => translateCommand("drag_to", {})).toThrow("Unsupported");
});
test("refuses missing images and reported errors", () => {
  expect(() => decodeDriverScreenshot({})).toThrow("no desktop PNG");
  expect(() =>
    decodeDriverScreenshot({ ok: false, error: "capture denied" }),
  ).toThrow("capture denied");
  expect(() =>
    decodeDriverScreenshot({ screenshot_png_b64: "not a png" }),
  ).toThrow("invalid PNG");
});
test("preserves screenshot and reads native pixel dimensions", () => {
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  png.writeUInt32BE(1920, 16);
  png.writeUInt32BE(1080, 20);
  const encoded = png.toString("base64");
  expect(decodeDriverScreenshot({ screenshot_png_b64: encoded })).toEqual({
    success: true,
    image_data: encoded,
    size: { width: 1920, height: 1080 },
  });
});
