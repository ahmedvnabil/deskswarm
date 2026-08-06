/**
 * Talking to a machine's agent bridge.
 *
 * The bridge is cua's `computer_server` speaking to the desktop over VNC. It
 * answers a single `POST /cmd` with `{command, params}` — mouse, keyboard,
 * screen, window and screen-size operations — and replies as a stream of
 * `data: {json}` lines rather than one JSON body.
 *
 * Extracted here because two callers need it and they need different things
 * from it: the wall wants a cached PNG and treats any failure as "no picture",
 * while an MCP tool call has to report *why* it failed to the client that
 * asked. Sharing the wire format and parsing it once is the point; the policy
 * on top differs.
 */

export interface BridgeTarget {
  slug: string;
  bridge_host: string;
  bridge_port: number;
}

/** The bridge answered, and said no. Carries the bridge's own message. */
export class BridgeError extends Error {}
/** The bridge did not answer at all — asleep, starting, or wedged. */
export class BridgeUnreachable extends Error {}

/**
 * Pull the payload out of the bridge's `data:`-prefixed stream.
 *
 * The last complete object wins: the server emits progress lines before the
 * result, and the result is what the caller asked for. Malformed lines are
 * skipped rather than fatal — a partial line at the tail of a truncated
 * response should not lose a payload that already arrived intact.
 */
export function parseBridgeStream(text: string): any {
  let payload: any = null;
  for (let line of text.split("\n")) {
    line = line.trim();
    if (line.startsWith("data:")) line = line.slice(5).trim();
    if (!line.startsWith("{")) continue;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }
  }
  return payload;
}

/**
 * Run one bridge command and return its payload.
 *
 * Throws rather than returning a null, because every caller here has a client
 * waiting for an answer and "it didn't work" is not one. The two error types
 * are separated because they mean different things to the caller: unreachable
 * is worth waking the machine and retrying, a refusal is not.
 */
export async function bridgeCommand(
  target: BridgeTarget,
  command: string,
  params: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<any> {
  const url = `http://${target.bridge_host}:${target.bridge_port}/cmd`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    throw new BridgeUnreachable(
      err?.name === "TimeoutError"
        ? `${target.slug} did not answer within ${Math.round(timeoutMs / 1000)}s`
        : `${target.slug} is not reachable: ${err?.message ?? err}`,
    );
  }
  if (res.status !== 200) {
    throw new BridgeUnreachable(`${target.slug} answered HTTP ${res.status}`);
  }

  const payload = parseBridgeStream(await res.text());
  if (!payload) throw new BridgeError(`${target.slug} sent no usable reply`);
  if (payload.success === false) {
    throw new BridgeError(String(payload.error ?? `${command} failed`));
  }
  return payload;
}
