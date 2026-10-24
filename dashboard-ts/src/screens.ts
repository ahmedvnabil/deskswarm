/**
 * Stills of the machines' screens, cached.
 *
 * The wall shows every machine at once. Opening a live VNC stream per tile
 * would mean N simultaneous connections, so tiles poll a cached still and only
 * the tile you click gets a real interactive session.
 */

import { controlCommand, type ControlTarget } from "./control";
import { SHOT_TTL } from "./settings";

const cache = new Map<string, { at: number; png: Buffer }>();

export type { ControlTarget };

/**
 * Grab a PNG of one machine's screen through its Driver.
 *
 * Null for every failure, deliberately: this feeds a wall of tiles that
 * refreshes every few seconds, where a machine that cannot be photographed
 * right now is a placeholder, not an error worth propagating.
 */
export async function desktopScreenshot(view: ControlTarget): Promise<Buffer | null> {
  const now = Date.now();
  const hit = cache.get(view.slug);
  if (hit && now - hit.at < SHOT_TTL * 1000) return hit.png;

  let payload: any;
  try { payload = await controlCommand(view, "screenshot", {}, 12_000); }
  catch { return null; }

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
