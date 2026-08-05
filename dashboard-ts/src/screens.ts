/**
 * Stills of the machines' screens, cached.
 *
 * The wall shows every machine at once. Opening a live VNC stream per tile
 * would mean N simultaneous connections, so tiles poll a cached still and only
 * the tile you click gets a real interactive session.
 */

import { SHOT_TTL } from "./settings";

const cache = new Map<string, { at: number; png: Buffer }>();

export interface BridgeTarget {
  slug: string;
  bridge_host: string;
  bridge_port: number;
}

/** Grab a PNG of one machine's screen through its bridge. */
export async function bridgeScreenshot(view: BridgeTarget): Promise<Buffer | null> {
  const now = Date.now();
  const hit = cache.get(view.slug);
  if (hit && now - hit.at < SHOT_TTL * 1000) return hit.png;

  const url = `http://${view.bridge_host}:${view.bridge_port}/cmd`;
  let text: string;
  try {
    const res = await fetch(url, {
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

  // The bridge answers as an SSE-ish stream: `data: {json}`. The last complete
  // object wins, which is what the payload actually is.
  let payload: any = null;
  for (let line of text.split("\n")) {
    line = line.trim();
    if (line.startsWith("data:")) line = line.slice(5).trim();
    if (line.startsWith("{")) {
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }
    }
  }
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
