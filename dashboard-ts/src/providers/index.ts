/**
 * Which backend owns which machine.
 *
 * The provider is per machine, not per process: the point of the abstraction
 * is a fleet that mixes Linux containers with something else, so "the fleet
 * runs on Docker" is exactly the assumption this has to stop making. Each
 * row in `computers` carries the name of the backend that created it, and
 * every operation is dispatched on that.
 *
 * Machines created before the column existed have no name, and the default
 * covers them — which is what makes adopting this a no-op for an existing
 * database.
 */

import { one } from "../db";
import { env } from "../settings";
import { dockerProvider } from "./docker";
import type { MachineProvider } from "./types";

export * from "./types";
export { dockerProvider };

/** Provider-independent helpers that happen to live with the Docker one for
 *  now; nothing about a slug or a random password is Docker-specific. */
export { randomVncPassword, slugify } from "./docker";

const REGISTRY: Record<string, MachineProvider> = {
  [dockerProvider.name]: dockerProvider,
};

export const providerNames = (): string[] => Object.keys(REGISTRY);

/** The backend new machines are created on. */
export const defaultProviderName = (): string =>
  env("DESKSWARM_PROVIDER", dockerProvider.name);

export function providerByName(name?: string | null): MachineProvider {
  const wanted = name || defaultProviderName();
  const found = REGISTRY[wanted];
  if (found) return found;
  // A row naming a backend this build does not have is a real problem — it
  // means machines nobody can reach — so say which, rather than quietly
  // driving them with the wrong one.
  throw new Error(
    `unknown machine provider '${wanted}' (have: ${providerNames().join(", ")})`,
  );
}

/** The backend for a machine you already have the row of. */
export const providerFor = (comp: { provider?: string | null }): MachineProvider =>
  providerByName(comp.provider);

/**
 * The backend for a machine you only have the slug of.
 *
 * Backups and restores are addressed by slug because that is what a backup
 * file is named after; one indexed lookup is cheaper than threading the row
 * through every one of them.
 */
export function providerForSlug(slug: string): MachineProvider {
  const row = one<{ provider: string | null }>(
    "SELECT provider FROM computers WHERE slug = ?",
    slug,
  );
  return providerByName(row?.provider);
}
