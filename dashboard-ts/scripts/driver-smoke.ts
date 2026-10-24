/** Run inside the dashboard container, against a disposable, registered machine.
 * Requires the GTK fixture running at its initial position (150,150). */
import { one } from "../src/db";
import { create, revoke } from "../src/mcp/keys";
import { providerFor } from "../src/providers";
import { writeFileSync } from "node:fs";
const slug = process.argv[2];
if (!slug)
  throw new Error(
    "Pass a disposable machine slug: bun scripts/driver-smoke.ts <slug>",
  );
const comp = one<any>("SELECT * FROM computers WHERE slug=?", slug);
if (!comp) throw new Error("Register the disposable machine first");
const steps: [string, Record<string, unknown>][] = [
  ["screenshot", {}],
  ["click", { x: 400, y: 265 }],
  ["click", { x: 400, y: 215 }],
  ["hotkey", { keys: ["ctrl", "a"] }],
  ["type_text", { text: "MCP 42" }],
  ["press_key", { key: "BackSpace" }],
  ["type_text", { text: " مرحبا بالعالم" }],
];
const backend = providerFor(comp);
const readState = async () => {
  const result = await backend.execInDesktopResult(
    slug,
    "cat /tmp/deskswarm-acceptance.json",
  );
  if (!result.ok) throw new Error(result.output);
  return JSON.parse(result.output);
};
async function waitForState(predicate: (state: any) => boolean, label: string) {
  const deadline = performance.now() + 5000;
  let state;
  do {
    state = await readState();
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (performance.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(state)}`);
}
const before = await readState();
const key = create(comp.id, "driver-acceptance", 1);
try {
  for (const [name, args] of steps) {
    const start = performance.now();
    const response = await fetch(
      `http://localhost:${process.env.PORT || 7000}/mcp/${slug}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${key.token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      },
    );
    const body = (await response.json()) as any;
    if (!response.ok || body.error || body.result?.isError)
      throw new Error(JSON.stringify(body));
    if (name === "screenshot") {
      const image = body.result.content.find((c: any) => c.type === "image");
      if (!image) throw new Error("No screenshot");
      writeFileSync(
        "/app/data/driver-acceptance.png",
        Buffer.from(image.data, "base64"),
      );
    }
    console.log(name, Math.round(performance.now() - start), "ms");
  }
  const after = await waitForState(
    (s) => s.text === "MCP 4 مرحبا بالعالم" && s.clicks === before.clicks + 1,
    "keyboard readback",
  );
  if (
    after.clicks !== before.clicks + 1 ||
    after.text !== "MCP 4 مرحبا بالعالم"
  )
    throw new Error(`Readback mismatch: ${JSON.stringify(after)}`);
  console.log(
    "PASS: independent mouse, hotkey, BackSpace, English and Arabic readback",
    JSON.stringify(after),
  );
  async function tool(name: string, args: Record<string, unknown>) {
    const res = await fetch(
      `http://localhost:${process.env.PORT || 7000}/mcp/${slug}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${key.token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      },
    );
    const body = (await res.json()) as any;
    if (!res.ok || body.error || body.result?.isError)
      throw new Error(JSON.stringify(body));
    if (name === "screenshot") {
      const image = body.result.content.find(
        (item: any) => item.type === "image",
      );
      if (!image) throw new Error("No screenshot");
      writeFileSync(
        "/app/data/driver-acceptance.png",
        Buffer.from(image.data, "base64"),
      );
    }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  await tool("click", { x: 500, y: 315 });
  await waitForState(
    (s) => !s.selected_text,
    "Drag precondition: selection must start empty",
  );
  await tool("drag", { from_x: 185, from_y: 315, to_x: 500, to_y: 315 });
  await settle();
  const dragged = await waitForState(
    (s) => s.selected_text === "DRAG SELECT THIS TEXT",
    "drag selection readback",
  );
  if (dragged.selected_text !== "DRAG SELECT THIS TEXT")
    throw new Error(
      `Drag did not select the complete text: ${JSON.stringify(dragged)}`,
    );
  await tool("move_mouse", { x: 450, y: 450 });
  const scrollBefore = (await readState()).scroll_value;
  await tool("scroll", { direction: "down", clicks: 5 });
  await settle();
  const down = (
    await waitForState(
      (s) => s.scroll_value > scrollBefore,
      "scroll down readback",
    )
  ).scroll_value;
  if (!(down > scrollBefore))
    throw new Error(
      `Scroll down had no application effect: ${scrollBefore} -> ${down}`,
    );
  await tool("scroll", { direction: "up", clicks: 3 });
  await settle();
  const up = (
    await waitForState((s) => s.scroll_value < down, "scroll up readback")
  ).scroll_value;
  if (!(up < down))
    throw new Error(`Scroll up had no application effect: ${down} -> ${up}`);
  await tool("screenshot", {});
  console.log(
    "PASS: drag selected",
    JSON.stringify(dragged.selected_text),
    "scroll adjustment",
    JSON.stringify({ before: scrollBefore, down, up }),
  );
} finally {
  revoke(key.id);
}
