/**
 * What a client holding a key can do to the machine it was given.
 *
 * One table, because the tool list an MCP client sees and the code that runs
 * the calls should not be able to drift apart — a tool advertised but not
 * implemented, or implemented but never advertised, are both bugs you only
 * find from the far side of someone else's client.
 *
 * The split underneath is not arbitrary. Screen and keyboard go through the
 * machine's Driver, which is the only thing that can reach the X session.
 * Shell, files, clipboard and inventory go through the provider, because it
 * already does them safely — paths confined to the home directory, ownership
 * set to the desktop user, clipboard tooling installed on demand — and
 * reimplementing any of that against the Driver would be a second, worse copy.
 */

import { controlCommand } from "./../control";
import { posix } from "node:path";
import { providerFor } from "./../providers";
import { invalidateScreen } from "./../screens";
import { MAX_CLIPBOARD_KB } from "./../settings";
import type { ControlTarget } from "./../control";
import type { Computer } from "./../machines";

export interface ToolContext {
  comp: Computer;
  target: ControlTarget;
  timeoutMs: number;
}

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Changes what is on the screen, so the wall's cached frame is now a lie. */
  mutates?: boolean;
  handler(ctx: ToolContext, args: Record<string, any>): Promise<Content[]>;
}

/** A tool call the client got wrong — reported as a tool error, not a
 *  protocol one, so the model on the other end can correct itself. */
export class ToolError extends Error {}

const text = (s: string): Content[] => [{ type: "text", text: s }];

function num(args: Record<string, any>, name: string): number {
  const v = Number(args?.[name]);
  if (!Number.isFinite(v)) throw new ToolError(`${name} must be a number`);
  return Math.round(v);
}

function str(args: Record<string, any>, name: string, fallback?: string): string {
  const v = args?.[name];
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    throw new ToolError(`${name} is required`);
  }
  return String(v);
}

const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const XY = {
  x: { type: "number", description: "Pixel from the left edge of the screen." },
  y: { type: "number", description: "Pixel from the top edge of the screen." },
};

const BUTTON = {
  type: "string",
  enum: ["left", "right", "middle"],
  default: "left",
};

export const TOOLS: Tool[] = [
  // ----------------------------------------------------------------- screen
  {
    name: "screenshot",
    title: "Screenshot",
    description:
      "Take a picture of the machine's screen right now. Start here — every " +
      "coordinate the click and drag tools take is read off this image.",
    inputSchema: schema({}),
    async handler(ctx) {
      const payload = await controlCommand(ctx.target, "screenshot", {}, ctx.timeoutMs);
      if (!payload?.image_data) throw new ToolError("the machine returned no image");
      return [{ type: "image", data: String(payload.image_data), mimeType: "image/png" }];
    },
  },
  {
    name: "screen_size",
    title: "Screen size",
    description: "The machine's screen resolution, in pixels.",
    inputSchema: schema({}),
    async handler(ctx) {
      const p = await controlCommand(ctx.target, "get_screen_size", {}, ctx.timeoutMs);
      const size = p?.size ?? p;
      return text(`${size?.width ?? "?"}x${size?.height ?? "?"}`);
    },
  },
  {
    name: "click",
    title: "Click",
    description: "Click at a point on the screen.",
    inputSchema: schema({ ...XY, button: BUTTON }, ["x", "y"]),
    mutates: true,
    async handler(ctx, args) {
      const x = num(args, "x");
      const y = num(args, "y");
      const button = str(args, "button", "left");
      await controlCommand(ctx.target, "click", { x, y, button, count: 1 }, ctx.timeoutMs);
      return text(`${button}-clicked at ${x},${y}`);
    },
  },
  {
    name: "double_click",
    title: "Double-click",
    description: "Double-click at a point on the screen.",
    inputSchema: schema({ ...XY }, ["x", "y"]),
    mutates: true,
    async handler(ctx, args) {
      const x = num(args, "x");
      const y = num(args, "y");
      await controlCommand(ctx.target, "click", { x, y, button: "left", count: 2 }, ctx.timeoutMs);
      return text(`double-clicked at ${x},${y}`);
    },
  },
  {
    name: "move_mouse",
    title: "Move the mouse",
    description:
      "Move the pointer without clicking — for hover menus and tooltips.",
    inputSchema: schema({ ...XY }, ["x", "y"]),
    mutates: true,
    async handler(ctx, args) {
      const x = num(args, "x");
      const y = num(args, "y");
      await controlCommand(ctx.target, "move_cursor", { x, y }, ctx.timeoutMs);
      return text(`moved to ${x},${y}`);
    },
  },
  {
    name: "drag",
    title: "Drag",
    description:
      "Press the button at one point, move to another, release. Use it for " +
      "selecting text, moving windows and drag-and-drop.",
    inputSchema: schema(
      {
        from_x: { type: "number" },
        from_y: { type: "number" },
        to_x: { type: "number" },
        to_y: { type: "number" },
        button: BUTTON,
      },
      ["from_x", "from_y", "to_x", "to_y"],
    ),
    mutates: true,
    async handler(ctx, args) {
      const fx = num(args, "from_x");
      const fy = num(args, "from_y");
      const tx = num(args, "to_x");
      const ty = num(args, "to_y");
      const button = str(args, "button", "left");
      await controlCommand(ctx.target, "drag", { from_x: fx, from_y: fy, to_x: tx, to_y: ty, button }, ctx.timeoutMs);
      return text(`dragged ${fx},${fy} -> ${tx},${ty}`);
    },
  },
  {
    name: "scroll",
    title: "Scroll",
    description: "Scroll the window under the pointer.",
    inputSchema: schema(
      {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        clicks: { type: "number", default: 3, description: "Wheel notches." },
      },
      ["direction"],
    ),
    mutates: true,
    async handler(ctx, args) {
      const direction = str(args, "direction");
      const clicks = args?.clicks === undefined ? 3 : num(args, "clicks");
      await controlCommand(
        ctx.target,
        "scroll",
        { direction, clicks },
        ctx.timeoutMs,
      );
      return text(`scrolled ${direction} ${clicks}`);
    },
  },
  {
    name: "type_text",
    title: "Type",
    description:
      "Type text into whatever window has focus. Non-Latin text (Arabic, " +
      "Chinese, emoji) is delivered through the clipboard and Ctrl+V " +
      "automatically, because the keyboard path cannot carry it — note that " +
      "terminal emulators do not bind Ctrl+V, so for non-Latin text in a " +
      "terminal, write a file and run it instead.",
    inputSchema: schema({ text: { type: "string" } }, ["text"]),
    mutates: true,
    async handler(ctx, args) {
      const value = str(args, "text");
      await controlCommand(ctx.target, "type_text", { text: value }, ctx.timeoutMs);
      return text(`typed ${value.length} characters`);
    },
  },
  {
    name: "press_key",
    title: "Press a key",
    description:
      "Press one key — Return, Tab, Escape, BackSpace, Down, F5, and so on.",
    inputSchema: schema({ key: { type: "string" } }, ["key"]),
    mutates: true,
    async handler(ctx, args) {
      const key = str(args, "key");
      await controlCommand(ctx.target, "press_key", { key }, ctx.timeoutMs);
      return text(`pressed ${key}`);
    },
  },
  {
    name: "hotkey",
    title: "Key combination",
    description:
      'Press keys together, e.g. ["ctrl","c"] or ["alt","F4"].',
    inputSchema: schema(
      { keys: { type: "array", items: { type: "string" }, minItems: 1 } },
      ["keys"],
    ),
    mutates: true,
    async handler(ctx, args) {
      const keys = args?.keys;
      if (!Array.isArray(keys) || !keys.length) {
        throw new ToolError("keys must be a non-empty array");
      }
      await controlCommand(
        ctx.target,
        "hotkey",
        { keys: keys.map(String) },
        ctx.timeoutMs,
      );
      return text(`pressed ${keys.join("+")}`);
    },
  },
  {
    name: "launch_app",
    title: "Launch an application",
    description:
      "Start a program on the desktop by name — firefox, xterm, thunar. " +
      "Faster and more reliable than clicking through a menu.",
    inputSchema: schema(
      {
        app: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
      ["app"],
    ),
    mutates: true,
    async handler(ctx, args) {
      const app = str(args, "app");
      const argv = Array.isArray(args?.args) ? args.args.map(String) : [];
      const backend = providerFor(ctx.comp);
      // Checked rather than assumed: launching detached means nothing reports
      // back, so a missing program would otherwise look exactly like a
      // successful launch — right up until the screenshot shows nothing.
      const probe = await backend.execInDesktopResult(
        ctx.comp.slug,
        `command -v ${JSON.stringify(app)}`,
      );
      if (probe.exit_code !== 0) {
        throw new ToolError(
          `'${app}' is not installed on ${ctx.comp.name}. Install it first, ` +
            `e.g. shell: apt-get update && apt-get install -y ${app}`,
        );
      }
      await backend.launchApp(ctx.comp.slug, app, argv);
      return text(`launched ${app}`);
    },
  },

  // ------------------------------------------------------------------ shell
  {
    name: "shell",
    title: "Run a shell command",
    description:
      "Run a command inside the machine as root and return its output. This " +
      "is how you install software (apt-get install ...), inspect the system, " +
      "or do anything faster than driving the GUI would be.",
    inputSchema: schema({ command: { type: "string" } }, ["command"]),
    mutates: true,
    async handler(ctx, args) {
      const command = str(args, "command").trim();
      if (!command) throw new ToolError("command is required");
      const res = await providerFor(ctx.comp).execInDesktopResult(
        ctx.comp.slug,
        command,
      );
      const body = res.output.trim();
      // The exit code is stated rather than thrown on: a non-zero exit is
      // information the caller asked for, not a failure of the tool.
      return text(
        `exit ${res.exit_code ?? "?"}\n${body || "(no output)"}`,
      );
    },
  },

  // ------------------------------------------------------------------ files
  {
    name: "list_files",
    title: "List files",
    description:
      "List a directory in the machine's home. Paths are relative to the " +
      "home directory and cannot climb out of it.",
    inputSchema: schema({
      path: { type: "string", default: "", description: "Relative to the home directory." },
    }),
    async handler(ctx, args) {
      const rel = str(args, "path", "");
      const entries = await providerFor(ctx.comp).listHome(ctx.comp.slug, rel);
      if (!entries.length) return text(`${rel || "~"} is empty`);
      const lines = entries.map(
        (e) => `${e.type === "dir" ? "d" : "-"} ${String(e.size).padStart(9)}  ${e.name}`,
      );
      return text(`${rel || "~"}\n${lines.join("\n")}`);
    },
  },
  {
    name: "read_file",
    title: "Read a file",
    description:
      "Read a file from the machine's home directory. Text by default; ask " +
      "for base64 to pull a binary out.",
    inputSchema: schema(
      {
        path: { type: "string" },
        encoding: { type: "string", enum: ["text", "base64"], default: "text" },
      },
      ["path"],
    ),
    async handler(ctx, args) {
      const rel = str(args, "path");
      const encoding = str(args, "encoding", "text");
      const [buf, , isTar] = await providerFor(ctx.comp).downloadFromHome(
        ctx.comp.slug,
        rel,
      );
      if (isTar) {
        throw new ToolError(
          `'${rel}' is a directory — list_files it, or tar it yourself with shell`,
        );
      }
      return text(encoding === "base64" ? buf.toString("base64") : buf.toString("utf8"));
    },
  },
  {
    name: "write_file",
    title: "Write a file",
    description:
      "Create or replace a file in the machine's home directory, owned by " +
      "the desktop user so the session can open it.",
    inputSchema: schema(
      {
        path: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string", enum: ["text", "base64"], default: "text" },
      },
      ["path", "content"],
    ),
    async handler(ctx, args) {
      const rel = str(args, "path").replace(/^\/+/, "");
      const content = str(args, "content");
      const encoding = str(args, "encoding", "text");
      const slash = rel.lastIndexOf("/");
      const dir = slash === -1 ? "" : rel.slice(0, slash);
      const filename = slash === -1 ? rel : rel.slice(slash + 1);
      if (!filename) throw new ToolError(`'${rel}' does not name a file`);

      const backend = providerFor(ctx.comp);
      const targetDir = posix.normalize(posix.join("/home/cua", dir));
      if (targetDir !== "/home/cua" && !targetDir.startsWith("/home/cua/"))
        throw new ToolError("Path is outside the home directory");
      if (dir) {
        // uploadToHome puts a file into a directory that already exists, so a
        // nested path has to be made first — as the desktop user, or the
        // session cannot write into the directory it was just given.
        const res = await backend.execInDesktopResult(
          ctx.comp.slug,
          `install -d -o cua -g cua -- '${targetDir.replace(/'/g, `'"'"'`)}'`,
        );
        if (res.exit_code !== 0) {
          throw new ToolError(`could not create '${dir}': ${res.output.trim()}`);
        }
      }
      const data = Buffer.from(content, encoding === "base64" ? "base64" : "utf8");
      const written = await backend.uploadToHome(ctx.comp.slug, dir, filename, data);
      return text(`wrote ${data.length} bytes to ${written}`);
    },
  },

  // -------------------------------------------------------------- clipboard
  {
    name: "get_clipboard",
    title: "Read the clipboard",
    description: "Read the machine's clipboard.",
    inputSchema: schema({}),
    async handler(ctx) {
      return text(await providerFor(ctx.comp).getClipboard(ctx.comp.slug));
    },
  },
  {
    name: "set_clipboard",
    title: "Write the clipboard",
    description:
      "Put text on the machine's clipboard, optionally pressing Ctrl+V " +
      "straight into the focused window. Ctrl+V is not what a terminal " +
      "emulator pastes with, so in one of those set the clipboard and paste " +
      "it by hand, or avoid the GUI and use shell.",
    inputSchema: schema(
      { text: { type: "string" }, paste: { type: "boolean", default: false } },
      ["text"],
    ),
    mutates: true,
    async handler(ctx, args) {
      const value = str(args, "text");
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes > MAX_CLIPBOARD_KB * 1024) {
        throw new ToolError(`clipboard text over ${MAX_CLIPBOARD_KB} KB`);
      }
      const backend = providerFor(ctx.comp);
      if (args?.paste) await backend.pasteText(ctx.comp.slug, value);
      else await backend.setClipboard(ctx.comp.slug, value);
      return text(`${bytes} bytes on the clipboard${args?.paste ? ", pasted" : ""}`);
    },
  },

  // ------------------------------------------------------------------- info
  {
    name: "inventory",
    title: "What is on this machine",
    description:
      "The machine's OS, kernel, installed runtimes and applications, package " +
      "count, disk and memory. Worth calling once before assuming a tool is " +
      "installed.",
    inputSchema: schema({}),
    async handler(ctx) {
      const inv = await providerFor(ctx.comp).getInventory(ctx.comp.slug);
      return text(JSON.stringify(inv, null, 2));
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The advertised shape, which is a subset of the table above — the handler
 *  and the mutates flag are ours, not the client's business. */
export const toolManifest = () =>
  TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

/** Run one call. Screen-changing tools drop the wall's cached frame so the
 *  next tile refresh shows what the client just did rather than the frame
 *  from before it. */
export async function runTool(
  tool: Tool,
  ctx: ToolContext,
  args: Record<string, any>,
): Promise<Content[]> {
  const out = await tool.handler(ctx, args ?? {});
  if (tool.mutates) invalidateScreen(ctx.comp.slug);
  return out;
}
