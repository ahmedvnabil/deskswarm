/**
 * Dynamic fleet management: create, destroy, inspect and shell into desktops.
 *
 * A "computer" is a pair of containers on the same Docker network:
 *   <prefix>-desktop-<slug>  — trycua/xfce-cua, a real XFCE session over VNC
 *   <prefix>-bridge-<slug>   — cua-computer-server in VNC-backend mode
 *
 * Both are created at runtime through the Docker API (the dashboard mounts
 * /var/run/docker.sock), so the fleet is not fixed by docker-compose.yml —
 * users add and remove machines from the UI.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createReadStream } from "node:fs";
import { basename, dirname, join, normalize, posix } from "node:path";
import * as tar from "tar-stream";

import { bufferStream, collect, docker, execInContainer, isNotFound } from "./docker";
import { env, envBool, envFloat, envInt } from "./settings";

export const DESKTOP_IMAGE = env("DESKSWARM_DESKTOP_IMAGE", "trycua/xfce-cua:latest");
export const BRIDGE_IMAGE = env("DESKSWARM_BRIDGE_IMAGE", "deskswarm-bridge:latest");
export const BRIDGE_CONTEXT = env("DESKSWARM_BRIDGE_CONTEXT", "/bridge-src");
export const CONTAINER_PREFIX = env("DESKSWARM_CONTAINER_PREFIX", "deskswarm-dyn");
const NETWORK_NAME = env("DESKSWARM_NETWORK");
// Empty means "whatever hostname the browser used to reach the dashboard",
// which is right far more often than any fixed value.
const PUBLIC_HOST = env("DESKSWARM_PUBLIC_HOST");
const NOVNC_PORT_BASE = envInt("DESKSWARM_NOVNC_PORT_BASE", 6901);
// Proxmox LXC and some nested-Docker hosts can't apply AppArmor profiles.
const DISABLE_APPARMOR = envBool("DESKSWARM_DISABLE_APPARMOR");

// Give every machine a named volume for its home directory. Without one a
// restart — or a rebuild onto a newer image — silently throws away whatever
// was on the desktop.
const PERSIST_HOME = envBool("DESKSWARM_PERSIST_HOME", true);
export const HOME_PATH = "/home/cua";

// Cap what one machine may take. Without these a single runaway tab starves
// every other machine and the dashboard with it. Set any to 0/"" to unbound.
const MACHINE_MEM_LIMIT = env("DESKSWARM_MACHINE_MEM_LIMIT", "2g");
const MACHINE_CPUS = envFloat("DESKSWARM_MACHINE_CPUS", 2);
const MACHINE_PIDS = envInt("DESKSWARM_MACHINE_PIDS", 512);
const BRIDGE_MEM_LIMIT = env("DESKSWARM_BRIDGE_MEM_LIMIT", "512m");

// null = not yet known. Some kernels and nested-container hosts refuse cgroup
// limits outright; we find out from Docker rather than guessing.
let limitsSupported: boolean | null = null;
export const limitsSupportedProbe = () => limitsSupported;
/** Forget what we learned about this host. The probe is a process-lifetime
 *  fact in production and a per-test one under test. */
export const resetLimitsProbe = () => {
  limitsSupported = null;
};

export class ClipboardUnavailable extends Error {}
export class PathOutsideHome extends Error {}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "computer";
}

export const desktopContainerName = (slug: string) =>
  `${CONTAINER_PREFIX}-desktop-${slug}`;
export const bridgeContainerName = (slug: string) =>
  `${CONTAINER_PREFIX}-bridge-${slug}`;
export const homeVolumeName = (slug: string) =>
  `${CONTAINER_PREFIX}-home-${slug}`;

/** "2g" / "512m" / "1024" -> bytes. The Python SDK accepted the suffixes
 *  directly; the Engine API wants a number. */
export function memBytes(value: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([bkmg])?$/i.exec((value || "").trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "b").toLowerCase();
  const scale = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[unit]!;
  return Math.round(n * scale);
}

/** Find the Docker network the dashboard itself is attached to. */
export async function detectNetwork(): Promise<string> {
  if (NETWORK_NAME) return NETWORK_NAME;
  const hostname = env("HOSTNAME");
  try {
    const info = await docker().getContainer(hostname).inspect();
    const nets = Object.keys(info.NetworkSettings?.Networks ?? {});
    if (nets.length) return nets[0];
  } catch {
    /* not in a container, or Docker can't say — fall through */
  }
  return "bridge";
}

/** Build the bridge image on first use if it isn't present. */
export async function ensureBridgeImage(): Promise<void> {
  try {
    await docker().getImage(BRIDGE_IMAGE).inspect();
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  if (!existsSync(join(BRIDGE_CONTEXT, "Dockerfile"))) {
    throw new Error(
      `bridge image '${BRIDGE_IMAGE}' is missing and no build context at ` +
        `${BRIDGE_CONTEXT} — mount ./bridge into the dashboard container`,
    );
  }
  const stream = await docker().buildImage(
    { context: BRIDGE_CONTEXT, src: readdirSync(BRIDGE_CONTEXT) },
    { t: BRIDGE_IMAGE, rm: true },
  );
  // followProgress resolves only once the build has actually finished; without
  // it the first machine would start against an image that isn't there yet.
  await new Promise<void>((resolve, reject) => {
    docker().modem.followProgress(stream, (err: any, out: any[]) => {
      if (err) return reject(err);
      const failed = out?.find((line) => line?.error);
      if (failed) return reject(new Error(failed.error));
      resolve();
    });
  });
}

export async function usedNovncPorts(): Promise<Set<number>> {
  const ports = new Set<number>();
  const containers = await docker().listContainers({ all: true });
  for (const c of containers) {
    for (const p of c.Ports ?? []) {
      if (p.PublicPort) ports.add(p.PublicPort);
    }
  }
  return ports;
}

export async function nextNovncPort(reserved: Iterable<number>): Promise<number> {
  const taken = await usedNovncPorts();
  for (const r of reserved) taken.add(r);
  let port = NOVNC_PORT_BASE;
  while (taken.has(port)) port += 1;
  return port;
}

/**
 * Link to a machine's screen.
 *
 * Each machine gets its own random VNC password, so a bare /vnc.html link
 * would just prompt for a secret the user has no way to know. Passing it as
 * autoconnect params makes "screen" work in one click.
 */
export function novncUrl(
  port: number,
  password?: string | null,
  host?: string | null,
): string {
  const base = `http://${PUBLIC_HOST || host || "localhost"}:${port}/vnc.html`;
  if (password) {
    return `${base}?autoconnect=true&resize=scale&password=${encodeURIComponent(password)}`;
  }
  return base;
}

interface Limits {
  Memory?: number;
  NanoCpus?: number;
  PidsLimit?: number;
}

/** Docker kwargs capping one container's share of the host. */
export function resourceLimits(mem: string): Limits {
  const limits: Limits = {};
  const bytes = memBytes(mem);
  if (bytes) limits.Memory = bytes;
  if (MACHINE_CPUS > 0) limits.NanoCpus = Math.round(MACHINE_CPUS * 1e9);
  if (MACHINE_PIDS > 0) limits.PidsLimit = MACHINE_PIDS;
  return limits;
}

// Docker phrases "this kernel can't do that" a dozen different ways; these are
// the fragments common to all of them.
const UNSUPPORTED_HINTS = [
  "cgroup",
  "memory limit",
  "pids limit",
  "not supported",
  "no such file or directory",
  "oom",
  "cpu cfs",
];

/**
 * createContainer + start, degrading gracefully when the host refuses limits.
 *
 * A Proxmox LXC or an unprivileged nested Docker may not have the cgroup
 * controllers delegated. Refusing to start the machine at all would be worse
 * than running it unbounded, so we try once, learn, and stop asking.
 */
export async function runContainer(spec: any, limits: Limits = {}): Promise<void> {
  const withLimits = {
    ...spec,
    HostConfig: { ...spec.HostConfig, ...limits },
  };
  const hasLimits = Object.keys(limits).length > 0;

  if (hasLimits && limitsSupported !== false) {
    try {
      const c = await docker().createContainer(withLimits);
      await c.start();
      limitsSupported = true;
      return;
    } catch (err: any) {
      const msg = String(err?.message ?? err).toLowerCase();
      if (!UNSUPPORTED_HINTS.some((h) => msg.includes(h))) throw err;
      limitsSupported = false;
      // A container can be created and then fail to start; clear the husk so
      // the retry below doesn't collide with its own name.
      await docker()
        .getContainer(spec.name)
        .remove({ force: true })
        .catch(() => {});
    }
  }
  const c = await docker().createContainer(spec);
  await c.start();
}

/**
 * Start the desktop + bridge container pair for one computer.
 *
 * `image` overrides the stock desktop image, which is how a machine gets
 * created from a snapshot of an already-provisioned one.
 */
export async function createComputer(
  slug: string,
  novncPort: number,
  vncPassword: string,
  image?: string | null,
): Promise<void> {
  await ensureBridgeImage();
  const network = await detectNetwork();
  const securityOpt = DISABLE_APPARMOR ? ["apparmor:unconfined"] : undefined;

  // Only the desktop gets the home volume; the bridge has no business holding
  // a reference to the user's files. Docker seeds a fresh named volume from
  // the image's own /home/cua, so a new machine still gets its skeleton.
  const binds = PERSIST_HOME
    ? [`${homeVolumeName(slug)}:${HOME_PATH}:rw`]
    : undefined;

  await runContainer(
    {
      name: desktopContainerName(slug),
      Image: image || DESKTOP_IMAGE,
      Env: [`VNC_PW=${vncPassword}`],
      ExposedPorts: { "6901/tcp": {} },
      Labels: { "deskswarm.role": "desktop", "deskswarm.slug": slug },
      HostConfig: {
        PortBindings: { "6901/tcp": [{ HostPort: String(novncPort) }] },
        NetworkMode: network,
        RestartPolicy: { Name: "unless-stopped" },
        Binds: binds,
        SecurityOpt: securityOpt,
      },
    },
    resourceLimits(MACHINE_MEM_LIMIT),
  );

  await runContainer(
    {
      name: bridgeContainerName(slug),
      Image: BRIDGE_IMAGE,
      Env: [
        `VNC_HOST=${desktopContainerName(slug)}`,
        "VNC_PORT=5901",
        `VNC_PASSWORD=${vncPassword}`,
        "BRIDGE_PORT=8000",
      ],
      Labels: { "deskswarm.role": "bridge", "deskswarm.slug": slug },
      HostConfig: {
        NetworkMode: network,
        RestartPolicy: { Name: "unless-stopped" },
        SecurityOpt: securityOpt,
      },
    },
    resourceLimits(BRIDGE_MEM_LIMIT),
  );
}

/** Commit a running desktop container to an image so new machines can be
 *  created pre-loaded with whatever was installed on it. */
export async function snapshotComputer(slug: string, tag: string): Promise<string> {
  const repo = `${CONTAINER_PREFIX}-snapshot`;
  await docker().getContainer(desktopContainerName(slug)).commit({ repo, tag });
  return `${repo}:${tag}`;
}

export async function removeImage(image: string): Promise<void> {
  try {
    await docker().getImage(image).remove({ force: true });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/** Remove a machine. `keepHome` spares the home volume, which is what a
 *  restart needs — the containers go, the work stays. */
export async function destroyComputer(slug: string, keepHome = false): Promise<void> {
  for (const name of [bridgeContainerName(slug), desktopContainerName(slug)]) {
    try {
      await docker().getContainer(name).remove({ force: true });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  if (keepHome || !PERSIST_HOME) return;
  try {
    await docker().getVolume(homeVolumeName(slug)).remove({ force: true });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/** How much the machine's home volume holds, so the UI can say. */
export async function homeSizeMb(slug: string): Promise<number | null> {
  if (!PERSIST_HOME) return null;
  let info: any;
  try {
    info = await docker().df();
  } catch {
    return null;
  }
  const want = homeVolumeName(slug);
  for (const v of info?.Volumes ?? []) {
    if (v?.Name === want) {
      const size = v?.UsageData?.Size ?? -1;
      return size >= 0 ? Math.round((size / 1e6) * 10) / 10 : null;
    }
  }
  return null;
}

export interface ContainerState {
  desktop_state: string;
  bridge_state: string;
}

export async function containerState(slug: string): Promise<ContainerState> {
  const out: ContainerState = { desktop_state: "missing", bridge_state: "missing" };
  const pairs: [keyof ContainerState, string][] = [
    ["desktop_state", desktopContainerName(slug)],
    ["bridge_state", bridgeContainerName(slug)],
  ];
  await Promise.all(
    pairs.map(async ([key, name]) => {
      try {
        const info = await docker().getContainer(name).inspect();
        out[key] = info.State?.Status ?? "missing";
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }),
  );
  return out;
}

// ------------------------------------------------------------ sleep / wake

/**
 * Stop both containers, freeing their memory and CPU entirely.
 *
 * This is `docker stop`, not `docker pause`: pausing keeps every page of RAM
 * resident, and RAM is the thing that runs out first. The X session ends, so
 * open windows are lost; the home volume is untouched.
 *
 * The bridge goes first so it isn't left retrying a VNC socket that just
 * disappeared.
 */
export async function suspendComputer(slug: string): Promise<void> {
  for (const name of [bridgeContainerName(slug), desktopContainerName(slug)]) {
    try {
      await docker().getContainer(name).stop({ t: 10 });
    } catch (err: any) {
      // 304 = already stopped, which is the state the caller wanted anyway.
      if (!isNotFound(err) && err?.statusCode !== 304) throw err;
    }
  }
}

/** Start the pair back up — desktop first, so the bridge finds a VNC server
 *  waiting rather than backing off. */
export async function resumeComputer(slug: string): Promise<void> {
  for (const name of [desktopContainerName(slug), bridgeContainerName(slug)]) {
    try {
      await docker().getContainer(name).start();
    } catch (err: any) {
      if (isNotFound(err) || err?.statusCode === 304) continue;
      if (!String(err?.message ?? "").toLowerCase().includes("already started")) {
        throw err;
      }
    }
  }
}

// websockify listens on 6901 inside the desktop; a browser watching the screen
// shows up here as an established connection. Port 5901 is deliberately not
// counted — the bridge holds that one open permanently, so it would make every
// machine look busy forever.
export const VNC_WATCHERS_SCRIPT =
  `awk 'NR>1 && $4=="01" {split($2,a,":"); if (a[2]=="1AF5") n++} END{print n+0}' ` +
  `/proc/net/tcp 2>/dev/null || echo 0`;

export async function isRunning(slug: string): Promise<boolean> {
  try {
    const info = await docker().getContainer(desktopContainerName(slug)).inspect();
    return info.State?.Status === "running";
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

// ------------------------------------------------------- backup / restore

/**
 * A stream of a tar of the machine's whole home directory.
 *
 * Docker serves a stopped container's filesystem as happily as a running one,
 * so backing up the fleet doesn't mean waking all of it first. Members come
 * out prefixed `cua/`, which is why restore unpacks into /home.
 */
export async function homeArchiveStream(slug: string): Promise<NodeJS.ReadableStream> {
  const c = docker().getContainer(desktopContainerName(slug));
  return (await c.getArchive({ path: HOME_PATH })) as unknown as NodeJS.ReadableStream;
}

/**
 * Replace the machine's home volume from a tar on disk.
 *
 * Done through a short-lived helper container rather than the desktop itself:
 * the desktop is stopped during a restore and so can't be told to clear
 * anything, and the helper can mount the volume at the same path without a
 * live session reading it underneath us.
 *
 * The helper runs the bridge image — already built and local, so this pulls
 * nothing and works on a host with no internet.
 */
export async function restoreHome(slug: string, tarPath: string, wipe = true): Promise<void> {
  await ensureBridgeImage();
  const name = `${CONTAINER_PREFIX}-restore-${slug}`;
  // A previous restore that died mid-flight leaves the helper behind, and the
  // name would then collide for ever.
  await docker().getContainer(name).remove({ force: true }).catch(() => {});

  const helper = await docker().createContainer({
    name,
    Image: BRIDGE_IMAGE,
    Entrypoint: ["sleep", "600"],
    Labels: { "deskswarm.role": "restore", "deskswarm.slug": slug },
    HostConfig: { Binds: [`${homeVolumeName(slug)}:${HOME_PATH}:rw`] },
  });
  await helper.start();
  try {
    if (wipe) {
      // Anything the backup doesn't contain should not survive it — otherwise
      // "restore" quietly means "merge", and the machine ends up in a state
      // that never existed.
      await execInContainer(name, ["find", HOME_PATH, "-mindepth", "1", "-delete"]);
    }
    await helper.putArchive(createReadStream(tarPath) as any, {
      path: dirname(HOME_PATH),
    });
    await execInContainer(name, ["chown", "-R", "1000:1000", HOME_PATH]);
  } finally {
    await helper.remove({ force: true }).catch(() => {});
  }
}

/**
 * How many machines are actually running.
 *
 * The memory guard budgets per machine, and a sleeping machine costs nothing —
 * counting it would refuse new machines while the RAM it is supposedly using
 * sits free. One labelled `docker ps`, not one inspect per machine.
 */
export async function awakeMachineCount(): Promise<number | null> {
  try {
    const list = await docker().listContainers({
      filters: { label: ["deskswarm.role=desktop"], status: ["running"] },
    });
    return list.length;
  } catch {
    return null;
  }
}

/**
 * How many browsers have this machine's screen open, or null if it is asleep
 * or unreachable. Read straight from /proc/net/tcp because `ss` and `netstat`
 * are not in every desktop image, but /proc always is.
 */
export async function vncWatchers(slug: string): Promise<number | null> {
  try {
    if (!(await isRunning(slug))) return null;
    const res = await execInContainer(desktopContainerName(slug), [
      "sh",
      "-c",
      VNC_WATCHERS_SCRIPT,
    ]);
    const n = parseInt((res.output || "0").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Run a shell command inside the desktop container (management shell). */
export async function execInDesktop(slug: string, command: string) {
  try {
    return await execInContainer(desktopContainerName(slug), ["bash", "-lc", command], {
      workdir: "/home/cua",
      env: { HOME: "/home/cua", DISPLAY: ":1" },
    });
  } catch (err) {
    if (isNotFound(err)) {
      return { ok: false, exit_code: null, output: "desktop container not found" };
    }
    throw err;
  }
}

/** exec_in_desktop's Python shape, which carried an `ok` alongside the code. */
export async function execInDesktopResult(slug: string, command: string) {
  const res = await execInDesktop(slug, command);
  return { ok: res.exit_code === 0, exit_code: res.exit_code, output: res.output };
}

const INVENTORY_SCRIPT = String.raw`
echo "##OS##"
. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -a
echo "##KERNEL##"
uname -r
echo "##RUNTIMES##"
for b in python3 node npm pip3 java go rustc php ruby perl git docker; do
  if command -v "$b" >/dev/null 2>&1; then
    v=$("$b" --version 2>&1 | grep -v '^[[:space:]]*$' | head -1)
    echo "$b|$v"
  fi
done
echo "##APPS##"
for b in firefox firefox-esr chromium google-chrome libreoffice thunar xfce4-terminal \
         code gimp vlc curl wget xdotool wmctrl xclip ffmpeg; do
  command -v "$b" >/dev/null 2>&1 && echo "$b"
done
echo "##PKGCOUNT##"
dpkg-query -f '.\n' -W 2>/dev/null | wc -l
echo "##PYPKGS##"
(pip3 list --disable-pip-version-check --format=freeze 2>/dev/null || true) | head -40
echo "##DISK##"
df -h / 2>/dev/null | tail -1
echo "##MEM##"
free -h 2>/dev/null | awk '/^Mem:/{print $2" total, "$3" used, "$7" available"}'
`;

export function parseInventory(raw: string) {
  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of raw.split("\n")) {
    const m = /^##([A-Z]+)##$/.exec(line.trim());
    if (m) {
      current = m[1];
      sections[current] = [];
    } else if (current && line.trim()) {
      sections[current].push(line.replace(/\s+$/, ""));
    }
  }
  const first = (key: string) => sections[key]?.[0] ?? null;

  const runtimes: { name: string; version: string }[] = [];
  for (const line of sections.RUNTIMES ?? []) {
    const idx = line.indexOf("|");
    if (idx > -1) {
      runtimes.push({
        name: line.slice(0, idx),
        version: line.slice(idx + 1).trim(),
      });
    }
  }
  const count = parseInt((first("PKGCOUNT") ?? "0").trim(), 10);

  return {
    os: first("OS"),
    kernel: first("KERNEL"),
    runtimes,
    apps: sections.APPS ?? [],
    package_count: Number.isFinite(count) ? count : null,
    python_packages: sections.PYPKGS ?? [],
    disk: first("DISK"),
    memory: first("MEM"),
  };
}

export async function getInventory(slug: string) {
  const res = await execInDesktop(slug, INVENTORY_SCRIPT);
  if (res.exit_code === null) return { error: res.output };
  return parseInventory(res.output);
}

export function randomVncPassword(): string {
  return randomBytes(8).toString("hex");
}

// -------------------------------------------------------------- clipboard

// X selections belong to a live client, so xclip has to outlive the exec that
// started it — hence setsid. Text moves base64-encoded in both directions:
// the clipboard carries UTF-8 (Arabic, emoji, newlines, quotes) and base64 is
// the only encoding that survives a shell command line untouched.
const CLIP_ENV = "export DISPLAY=:1 XAUTHORITY=/home/cua/.Xauthority;";

/** Single-quote for /bin/sh, the way Python's shlex.quote does. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

const asDesktopUser = (inner: string) =>
  `su cua -c ${shellQuote(CLIP_ENV + " " + inner)} </dev/null`;

/**
 * Make sure xclip and xdotool exist, installing them if they don't.
 *
 * The stock desktop image ships neither, and a container rebuild throws away
 * anything apt installed — so this is checked per call rather than once. The
 * check is a `command -v`, which costs milliseconds.
 */
export async function ensureClipboardTools(slug: string): Promise<void> {
  const probe = await execInDesktop(
    slug,
    "command -v xclip >/dev/null && command -v xdotool >/dev/null",
  );
  if (probe.exit_code === 0) return;
  const res = await execInDesktop(
    slug,
    "export DEBIAN_FRONTEND=noninteractive; " +
      "apt-get update -qq && apt-get install -y -qq xclip xdotool",
  );
  if (res.exit_code !== 0) {
    throw new ClipboardUnavailable(
      "this machine has no xclip/xdotool and installing them failed " +
        `(is it offline?): ${res.output.slice(-300).trim()}`,
    );
  }
}

export async function getClipboard(slug: string): Promise<string> {
  await ensureClipboardTools(slug);
  const res = await execInDesktop(
    slug,
    asDesktopUser("xclip -selection clipboard -o 2>/dev/null | base64 -w0"),
  );
  if (res.exit_code !== 0) {
    throw new ClipboardUnavailable(res.output.trim() || "could not read the clipboard");
  }
  const raw = res.output.trim();
  if (!raw) return "";
  return Buffer.from(raw, "base64").toString("utf8");
}

export async function setClipboard(slug: string, text: string): Promise<void> {
  await ensureClipboardTools(slug);
  const payload = Buffer.from(text, "utf8").toString("base64");
  const res = await execInDesktop(
    slug,
    asDesktopUser(
      `printf %s ${payload} | base64 -d | setsid xclip -selection clipboard -i`,
    ),
  );
  if (res.exit_code !== 0) {
    throw new ClipboardUnavailable(res.output.trim() || "could not set the clipboard");
  }
}

/**
 * Put text on the clipboard and press Ctrl+V in the focused window.
 *
 * This is also the only dependable way to get Arabic (or any non-Latin text)
 * into a desktop: xdotool's `type` goes through keysym lookup, which has no
 * mapping for most of these characters and silently drops them.
 */
export async function pasteText(slug: string, text: string): Promise<void> {
  await setClipboard(slug, text);
  const res = await execInDesktop(
    slug,
    asDesktopUser("xdotool key --clearmodifiers ctrl+v"),
  );
  if (res.exit_code !== 0) {
    throw new ClipboardUnavailable(res.output.trim() || "could not send Ctrl+V");
  }
}

// ------------------------------------------------------------------ files

/**
 * Resolve a user-supplied path inside /home/cua, or refuse.
 *
 * Paths arrive from the browser, so '../../etc/shadow' has to bounce here
 * rather than at the Docker API, which would happily serve it.
 */
export function safeHomePath(rel = ""): string {
  const target = posix.normalize(posix.join(HOME_PATH, (rel || "").replace(/^\/+/, "")));
  if (target !== HOME_PATH && !target.startsWith(HOME_PATH + "/")) {
    throw new PathOutsideHome(`'${rel}' is outside ${HOME_PATH}`);
  }
  return target;
}

const LIST_SCRIPT = String.raw`
cd "$1" 2>/dev/null || { echo "__MISSING__"; exit 0; }
for f in .* *; do
  [ "$f" = "." ] && continue
  [ "$f" = ".." ] && continue
  [ -e "$f" ] || continue
  if [ -d "$f" ]; then t=dir; sz=0; else t=file; sz=$(stat -c %s "$f" 2>/dev/null || echo 0); fi
  printf '%s|%s|%s\n' "$t" "$sz" "$f"
done
`;

export class HomePathMissing extends Error {}

export async function listHome(slug: string, rel = "") {
  const target = safeHomePath(rel);
  const res = await execInContainer(desktopContainerName(slug), [
    "bash",
    "-c",
    LIST_SCRIPT,
    "--",
    target,
  ]);
  if (res.output.includes("__MISSING__")) {
    throw new HomePathMissing(rel || HOME_PATH);
  }
  const entries = res.output
    .split("\n")
    .map((line) => line.split("|"))
    .filter((parts) => parts.length === 3)
    .map(([kind, size, name]) => ({
      name,
      type: kind,
      size: parseInt(size || "0", 10) || 0,
    }));
  entries.sort((a, b) => {
    if ((a.type !== "dir") !== (b.type !== "dir")) return a.type === "dir" ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return entries;
}

/** Drop one file into the machine's home. Owned by `cua`, or the desktop
 *  session could not open what you just handed it. */
export async function uploadToHome(
  slug: string,
  relDir: string,
  filename: string,
  data: Uint8Array,
): Promise<string> {
  if (filename.includes("/") || ["", ".", ".."].includes(filename)) {
    throw new PathOutsideHome(`bad filename '${filename}'`);
  }
  const targetDir = safeHomePath(relDir);

  const pack = tar.pack();
  pack.entry(
    {
      name: filename,
      size: data.length,
      mode: 0o644,
      mtime: new Date(),
      uid: 1000, // the desktop runs as cua (1000)
      gid: 1000,
      uname: "cua",
      gname: "cua",
    },
    Buffer.from(data),
  );
  pack.finalize();
  const archive = await collect(pack as unknown as NodeJS.ReadableStream);

  const c = docker().getContainer(desktopContainerName(slug));
  await c.putArchive(bufferStream(archive) as any, { path: targetDir });
  return posix.join(targetDir, filename);
}

/** Return [bytes, download name, isTar]. Directories come back as a tar,
 *  single files as themselves. */
export async function downloadFromHome(
  slug: string,
  rel: string,
): Promise<[Buffer, string, boolean]> {
  const target = safeHomePath(rel);
  const c = docker().getContainer(desktopContainerName(slug));
  const stream = (await c.getArchive({ path: target })) as unknown as NodeJS.ReadableStream;
  const raw = await collect(stream);
  const base = basename(target) || "home";

  const files: { name: string; body: Buffer }[] = [];
  await new Promise<void>((resolve, reject) => {
    const extract = tar.extract();
    extract.on("entry", (header, stream, next) => {
      if (header.type === "file") {
        collect(stream as unknown as NodeJS.ReadableStream).then((body) => {
          files.push({ name: header.name, body });
          next();
        }, reject);
      } else {
        stream.on("end", next);
        stream.resume();
      }
    });
    extract.on("finish", () => resolve());
    extract.on("error", reject);
    extract.end(raw);
  });

  // A single file is what people expect back as a file, not a tarball.
  if (files.length === 1 && files[0].name === base) {
    return [files[0].body, base, false];
  }
  return [raw, `${base}.tar`, true];
}
