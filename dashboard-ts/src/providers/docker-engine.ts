/**
 * The Docker client, and the few primitives the rest of the app needs from it.
 *
 * Kept apart from fleet.ts so that "how do I talk to Docker" and "what is a
 * machine" stay separate concerns — and because exec output and tar archives
 * both need handling that has nothing to do with the fleet.
 */

import Docker from "dockerode";
import { Readable } from "node:stream";

let client: Docker | null = null;

export function docker(): Docker {
  if (client === null) client = new Docker();
  return client;
}

/** True when Docker answered "no such thing" rather than failing. */
export function isNotFound(err: any): boolean {
  return err?.statusCode === 404;
}

export interface ExecResult {
  exit_code: number | null;
  output: string;
}

/**
 * Docker frames a non-TTY stream as [type][000][size:4BE][payload], with
 * stdout and stderr interleaved. The Python client's `demux=False` merged
 * them in arrival order and every caller here expects that, so this does the
 * same rather than splitting them apart and losing the interleaving.
 */
export function demultiplex(raw: Buffer): string {
  const parts: Buffer[] = [];
  let i = 0;
  while (i + 8 <= raw.length) {
    const type = raw[i];
    // A payload that doesn't start with a plausible frame header is a stream
    // that was never framed (an exec created with Tty: true). Take it whole
    // rather than slicing it into nonsense.
    if (type > 2) return raw.toString("utf8");
    const size = raw.readUInt32BE(i + 4);
    parts.push(raw.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return Buffer.concat(parts).toString("utf8");
}

export async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as any) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Run a command in a container and wait for it, returning merged output and
 * the exit status — the shape `container.exec_run()` had in the Python SDK.
 */
export async function execInContainer(
  containerName: string,
  cmd: string[],
  opts: { workdir?: string; env?: Record<string, string> } = {},
): Promise<ExecResult> {
  const container = docker().getContainer(containerName);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    WorkingDir: opts.workdir,
    Env: opts.env
      ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
      : undefined,
  });
  // No hijack. With it dockerode sends `Upgrade: tcp`, Docker answers 101,
  // and dockerode's accepted status codes for exec start do not include 101 —
  // so it treats the upgrade as an error and buffers the framed stream into
  // the message. Every exec-backed feature failed that way: the terminal, the
  // file browser, the clipboard and the inventory all returned
  // "(HTTP code 101) unexpected" with the real output visible inside it.
  //
  // Without hijack Docker answers 200 with the same multiplexed stream, which
  // is all a one-shot command needs.
  const stream = await exec.start({});
  const raw = await collect(stream as unknown as NodeJS.ReadableStream);
  const info = await exec.inspect();
  return { exit_code: info.ExitCode ?? null, output: demultiplex(raw) };
}

