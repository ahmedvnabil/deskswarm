/**
 * Backing up and restoring a machine's home directory.
 *
 * A persistent home only half-solves the problem it set out to solve: work
 * survives a restart, and then one `docker volume rm` — or one mistaken delete
 * from the wall — takes all of it. This is the other half.
 *
 * A backup is a gzipped tar of /home/cua, written straight to the dashboard's
 * data volume. Streamed in both directions: homes run to hundreds of megabytes
 * and holding one in memory on a host already short of it would be a poor way
 * to protect against data loss.
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import * as tar from "tar-stream";

import { providerForSlug } from "./providers";
import { env, envInt, nowIso } from "./settings";

export const BACKUP_DIR = env("DESKSWARM_BACKUP_DIR", "/app/data/backups");
// How many to keep per machine. Backups are the thing most likely to fill a
// disk quietly, and a full disk breaks Docker in confusing ways. Read at call
// time so changing it does not need a restart.
export const keepPerMachine = () => envInt("DESKSWARM_BACKUP_KEEP", 5);
// 'HH:MM' UTC to back the whole fleet up daily; empty disables it.
export const DAILY_AT = env("DESKSWARM_BACKUP_DAILY_AT").trim();

const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** A name that would escape the backup directory. */
export class BadBackupName extends Error {}

export function machineDir(slug: string): string {
  if (!NAME_RE.test(slug)) throw new BadBackupName(`bad machine name '${slug}'`);
  return join(BACKUP_DIR, slug);
}

/**
 * Resolve one backup file, refusing anything that climbs out.
 *
 * The name reaches here from a URL, so '../../etc/passwd' has to bounce at
 * this line rather than at open().
 */
export function backupPath(slug: string, name: string): string {
  if (!NAME_RE.test(name || "")) throw new BadBackupName(`bad backup name '${name}'`);
  const base = resolve(machineDir(slug));
  const target = resolve(join(base, name));
  if (target !== base && !target.startsWith(base + "/")) {
    throw new BadBackupName(`'${name}' is outside ${base}`);
  }
  return target;
}

export function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export interface BackupMeta {
  name: string;
  machine: string;
  bytes: number;
  seconds?: number;
  created_at: string;
}

/**
 * Write a new backup of one machine's home. Returns its metadata.
 *
 * Works on a sleeping machine too — Docker serves a stopped container's
 * filesystem — so backing up the fleet doesn't mean waking all of it.
 */
export async function create(slug: string, at = new Date()): Promise<BackupMeta> {
  const outDir = machineDir(slug);
  mkdirSync(outDir, { recursive: true });
  const name = `${stamp(at)}.tar.gz`;
  const final = join(outDir, name);
  // Write to a partial file and rename at the end: a backup interrupted
  // half-way must not be left looking like a complete one.
  const partial = final.replace(/\.tar\.gz$/, ".partial");

  const started = Date.now();
  try {
    const stream = await providerForSlug(slug).homeArchiveStream(slug);
    await pipeline(stream as any, createGzip({ level: 6 }), createWriteStream(partial));
    renameSync(partial, final);
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }

  prune(slug);
  return {
    name,
    machine: slug,
    bytes: statSync(final).size,
    seconds: Math.round(((Date.now() - started) / 1000) * 10) / 10,
    created_at: nowIso(),
  };
}

export function listing(slug: string): BackupMeta[] {
  const outDir = machineDir(slug);
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((f) => f.endsWith(".tar.gz"))
    .sort()
    .reverse()
    .map((f) => {
      const st = statSync(join(outDir, f));
      return {
        name: f,
        machine: slug,
        bytes: st.size,
        created_at: nowIso(new Date(st.mtimeMs)),
      };
    });
}

export function prune(slug: string): string[] {
  const keep = keepPerMachine();
  if (keep <= 0) return [];
  const dropped: string[] = [];
  for (const row of listing(slug).slice(keep)) {
    rmSync(join(machineDir(slug), row.name), { force: true });
    dropped.push(row.name);
  }
  return dropped;
}

export function remove(slug: string, name: string): boolean {
  const path = backupPath(slug, name);
  if (!existsSync(path) || !statSync(path).isFile()) return false;
  rmSync(path);
  return true;
}

export function totalBytes(): number {
  if (!existsSync(BACKUP_DIR)) return 0;
  let total = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".tar.gz")) total += statSync(p).size;
    }
  };
  walk(BACKUP_DIR);
  return total;
}

/**
 * Whether this entry stays inside the home directory.
 *
 * A tar is a list of paths chosen by whoever wrote it. These are our own
 * archives today, but restore also accepts an uploaded file, and a member
 * called '../../etc/cron.d/x' — or a symlink pointing at /etc that a later
 * member then writes through — is the oldest trick there is. It has to be
 * refused here, before anything is unpacked.
 */
export function isSafe(header: {
  name: string;
  type?: string;
  linkname?: string | null;
}): boolean {
  // posix-normalize without touching the filesystem
  const name = normalisePath(header.name);
  if (name.startsWith("/") || name.startsWith("..") || name === "." || name.includes("/../")) {
    return false;
  }
  if (header.type === "symlink" || header.type === "link") {
    const link = header.linkname || "";
    if (link.startsWith("/")) return false;
    const dir = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
    if (normalisePath(dir ? `${dir}/${link}` : link).startsWith("..")) return false;
  }
  return !["character-device", "block-device", "fifo"].includes(header.type ?? "");
}

function normalisePath(p: string): string {
  const leading = p.startsWith("/") ? "/" : "";
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else out.push(part);
  }
  return leading + out.join("/") || ".";
}

/**
 * Rewrite a backup into a tar holding only entries that are safe to unpack,
 * owned by the desktop user. Returns how many survived.
 *
 * Read as a stream so a large archive never lands in memory; that also means
 * one pass, so filtering happens per member as it arrives.
 */
export async function sanitise(source: string, dest: string): Promise<number> {
  let kept = 0;
  const extract = tar.extract();
  const pack = tar.pack();

  extract.on("entry", (header, stream, next) => {
    if (!isSafe(header as any)) {
      stream.on("end", next);
      stream.resume();
      return;
    }
    kept += 1;
    const out = pack.entry(
      { ...header, uid: 1000, gid: 1000, uname: "cua", gname: "cua" },
      (err?: Error | null) => {
        if (err) extract.destroy(err);
        next();
      },
    );
    stream.pipe(out);
  });
  extract.on("finish", () => pack.finalize());

  await Promise.all([
    pipeline(createReadStream(source), createGunzip(), extract as any),
    pipeline(pack as any, createWriteStream(dest)),
  ]);
  return kept;
}

/**
 * Replace a machine's home from a backup.
 *
 * The machine is stopped for the duration. Overwriting .config and friends
 * underneath a live X session leaves the desktop reading half of one home and
 * half of another, and that surfaces minutes later as something that looks
 * unrelated.
 */
export async function restore(slug: string, source: string, wipe = true) {
  const backend = providerForSlug(slug);
  const wasRunning = await backend.isRunning(slug);
  if (wasRunning) await backend.suspendComputer(slug);

  const staged = `${source}.staged-${process.pid}.tar`;
  let kept = 0;
  try {
    kept = await sanitise(source, staged);
    await backend.restoreHome(slug, staged, wipe);
  } finally {
    rmSync(staged, { force: true });
    if (wasRunning) await backend.resumeComputer(slug);
  }
  return { machine: slug, entries: kept, restarted: wasRunning };
}
