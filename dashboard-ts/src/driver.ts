/** Native Cua Driver 0.38.0 desktop actions, with no input replay. */
import { providerFor } from "./providers";
import type { ControlTarget } from "./control";
const session = "deskswarm-desktop";
export function translateCommand(command: string, params: Record<string, any>) {
  const args = { scope: "desktop", session };
  if (command === "click")
    return {
      tool: command,
      args: {
        ...args,
        x: params.x,
        y: params.y,
        button: params.button,
        count: params.count,
      },
    };
  if (command === "drag")
    return {
      tool: "drag",
      args: {
        ...args,
        from_x: params.from_x,
        from_y: params.from_y,
        to_x: params.to_x,
        to_y: params.to_y,
        button: params.button,
        duration_ms: 500,
      },
    };
  if (command === "move_cursor")
    return { tool: command, args: { ...args, x: params.x, y: params.y } };
  if (command === "type_text")
    return { tool: command, args: { ...args, text: params.text } };
  if (command === "press_key")
    return { tool: command, args: { ...args, key: params.key } };
  if (command === "hotkey")
    return params.keys.length === 1
      ? { tool: "press_key", args: { ...args, key: params.keys[0] } }
      : { tool: command, args: { ...args, keys: params.keys } };
  if (command === "scroll")
    return {
      tool: "scroll",
      args: {
        ...args,
        direction: params.direction,
        amount: params.clicks,
        by: "line",
      },
    };
  throw new Error(`Unsupported Driver command: ${command}`);
}
export function checkDriverResult(result: any) {
  if (
    !result ||
    result.isError ||
    result.ok === false ||
    result.error ||
    result.code
  )
    throw new Error(JSON.stringify(result));
  return result;
}
export async function driverCommand(
  target: ControlTarget,
  command: string,
  params: Record<string, any>,
  timeoutMs: number,
) {
  const slug = target.slug;
  const backend = providerFor(target);
  const started = performance.now();
  const call = async (tool: string, args: Record<string, unknown>) => {
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining <= 0)
      throw new Error(
        "Driver deadline exceeded; verify state before retrying input",
      );
    return checkDriverResult(
      await backend.driverCall(slug, tool, args, remaining),
    );
  };
  // Idempotent; also recreates the session after daemon restart or idle expiry.
  await call("start_session", { session, capture_scope: "desktop" });
  if (command === "screenshot" || command === "get_screen_size")
    return decodeDriverScreenshot(await call("get_desktop_state", { session }));
  if (
    command === "type_text" &&
    /[^\t\n\r\x20-\xFF]/.test(String(params.text))
  ) {
    await backend.setClipboard(slug, String(params.text));
    await call("hotkey", { session, scope: "desktop", keys: ["ctrl", "v"] });
  } else if (command === "scroll") {
    const cursor = await call("get_cursor_position", { session });
    const translated = translateCommand(command, params);
    await call(translated.tool, {
      ...translated.args,
      x: cursor.x,
      y: cursor.y,
    });
  } else {
    const translated = translateCommand(command, params);
    await call(translated.tool, translated.args);
  }
  return { success: true };
}
export function decodeDriverScreenshot(result: any) {
  checkDriverResult(result);
  const encoded = result.screenshot_png_b64;
  if (typeof encoded !== "string")
    throw new Error("Driver returned no desktop PNG");
  const png = Buffer.from(encoded, "base64");
  if (
    png.length < 24 ||
    png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  )
    throw new Error("Driver returned an invalid PNG");
  return {
    success: true,
    image_data: encoded,
    size: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) },
  };
}
