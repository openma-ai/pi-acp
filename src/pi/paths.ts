/**
 * Path helpers for locating this package and the Pi installation next to it.
 *
 * The adapter never resolves Pi for itself. npm auto-installs the
 * `@earendil-works/pi-coding-agent` peer dependency into this package's own
 * `node_modules`, and that copy is *not* the user's choice — it is excluded
 * from every candidate list (see `resolve.ts`).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The Pi SDK package this adapter runs on. */
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** This package's own name (used to find our package.json from a source file). */
export const ADAPTER_PACKAGE_NAME = "@openma/pi-acp";

export interface PackageManifest {
  name?: string;
  version?: string;
}

/** Read a `package.json`, if it exists and parses. */
export function readManifest(file: string): PackageManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") return undefined;
    return parsed as PackageManifest;
  } catch {
    return undefined;
  }
}

/** The package directory of `name`, starting the search at `startDir` and walking up. */
export function findPackageDirUpwards(startDir: string, name: string): string | undefined {
  let dir = resolve(startDir);
  for (let i = 0; i < 64; i += 1) {
    const manifest = readManifest(join(dir, "package.json"));
    if (manifest?.name === name) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** This adapter's own package directory (`…/node_modules/@openma/pi-acp`). */
export function ownPackageDir(): string | undefined {
  return findPackageDirUpwards(dirname(fileURLToPath(import.meta.url)), ADAPTER_PACKAGE_NAME);
}

/**
 * The Pi copy Node would resolve from this package's own location — npm's
 * auto-installed peer dependency. It is never a valid candidate.
 */
export function ownPeerPackageDir(): string | undefined {
  const own = ownPackageDir();
  if (own === undefined) return undefined;
  return findNodeModulesPackage(own, PI_PACKAGE_NAME);
}

/**
 * Node's module lookup: walk up from `startDir` and return the first
 * `node_modules/<name>` package directory found.
 */
export function findNodeModulesPackage(startDir: string, name: string): string | undefined {
  let dir = resolve(startDir);
  for (let i = 0; i < 64; i += 1) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * The `node_modules` root that holds this package (`…/node_modules`): the npm
 * prefix's global root for a global install, the project root for a local one.
 */
export function ownNodeModulesRoot(): string | undefined {
  const own = ownPackageDir();
  if (own === undefined) return undefined;
  const parts = own.split(/[\\/]/);
  const index = parts.lastIndexOf("node_modules");
  if (index < 0) return undefined;
  return parts.slice(0, index + 1).join(sep);
}
