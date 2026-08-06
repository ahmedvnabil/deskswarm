/**
 * Stills of the machines' screens, cached.
 *
 * The wall shows every machine at once. Opening a live VNC stream per tile
 * would mean N simultaneous connections, so tiles poll a cached still and only
 * the tile you click gets a real interactive session.
 */

import { parseBridgeStream, type BridgeTarget } from "./bridge";
import { SHOT_TTL } from "./settings";

const cache = new Map<string, { at: number; png: Buffer }>();

export type { BridgeTarget };

/**
 * Grab a PNG of one machine's screen through its bridge.
 *
 * Null for every failure, deliberately: this feeds a wall of tiles that
 * refreshes every few seconds, where a machine that cannot be photographed
 * right now is a placeholder, not an error worth propagating.
 */
export async function bridgeScreenshot(view: BridgeTarget): Promise<Buffer | null> {
  const now = Date.now();
  const hit = cache.get(view.slug);
  if (hit && now - hit.at < SHOT_TTL * 1000) return hit.png;

  let text: string;
  try {
    const res = await fetch(`http://${view.bridge_host}:${view.bridge_port}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "screenshot", params: {} }),
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status !== 200) return null;
    text = await res.text();
  } catch {
    return null;
  }

  const payload = parseBridgeStream(text);
  if (!payload?.success || !payload?.image_data) return null;

  let png: Buffer;
  try {
    png = Buffer.from(payload.image_data, "base64");
  } catch {
    return null;
  }
  cache.set(view.slug, { at: now, png });
  return png;
}

/** Drop a machine's cached frame. Called after an MCP tool call that changed
 *  the screen, so the wall shows the result rather than the stale frame it
 *  took a moment earlier. */
export function invalidateScreen(slug: string): void {
  cache.delete(slug);
}
