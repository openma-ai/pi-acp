/**
 * Where the user's Pi installation lives.
 *
 * The adapter never resolves Pi for itself. npm auto-installs the
 * `@earendil-works/pi-coding-agent` peer dependency into this package's own
 * `node_modules`; that copy is not the user's choice and is never a candidate.
 *
 * Candidates are tried in this order, and the first match wins:
 *
 * 1. `explicit`  — `--pi-package-dir` / `PI_ACP_PI_PACKAGE_DIR`
 * 2. `project`   — the copy the current working directory resolves to
 * 3. `path`      — the package behind the `pi` executable on `PATH`
 * 4. `global`    — the npm global root next to this package
 *
 * A candidate that resolves to npm's auto-installed peer copy is rejected
 * unless the surrounding project manifest declares Pi itself.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { PI_PACKAGE_NAME, readManifest } from "./paths.ts";

export type PiSource = "explicit" | "project" | "path" | "global";

export interface PiCandidate {
  source: PiSource;
  /** Absolute path of the `@earendil-works/pi-coding-agent` package directory. */
  packageDir: string;
  /** How the candidate was found (a path, a project directory, an executable). */
  detail: string;
}

export interface PiRejection {
  packageDir: string;
  source: PiSource;
  reason: string;
}

export interface ResolveContext {
  /** Explicit package location (`--pi-package-dir` / `PI_ACP_PI_PACKAGE_DIR`). */
  explicit?: string | undefined;
  /** Working directory the adapter runs in. */
  cwd: string;
  /** `PATH` entries to scan for the `pi` executable. */
  pathEntries: readonly string[];
  /** This adapter's own package directory. */
  adapterPackageDir?: string | undefined;
  /** The `node_modules` root that holds this adapter's package. */
  adapterNodeModulesRoot?: string | undefined;
  /** npm's auto-installed peer copy — never a candidate. */
  adapterPeerPackageDir?: string | undefined;
}

export interface ResolveResult {
  selected?: PiCandidate;
  rejections: PiRejection[];
}

/** Thrown when an explicitly requested location holds no Pi installation. */
export class PiLocationError extends Error {
  constructor(
    readonly location: string,
    message: string,
  ) {
    super(message);
    this.name = "PiLocationError";
  }
}

// ---------------------------------------------------------------------- //
// Path helpers (Windows-style paths stay intact on POSIX test runners)     //
// ---------------------------------------------------------------------- //

/** True for `C:\…` and `\\server\share` style paths. */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** Split a path into segments, remembering the separator style it used. */
export function splitPath(path: string): { parts: string[]; separator: string } {
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  return { parts: path.split(/[\\/]+/).filter((part) => part.length > 0), separator };
}

/** Collapse duplicate separators without changing the path flavour. */
export function normalizePath(path: string): string {
  if (!isWindowsPath(path)) return path.replace(/\/+/g, "/").replace(/\/$/, "");
  const unc = path.startsWith("\\\\");
  const body = path.replace(/[\\/]+/g, "\\").replace(/\\+$/, "");
  return unc ? `\\\\${body.replace(/^\\+/, "")}` : body;
}

/** Compare two directories, ignoring trailing separators (case-insensitive on Windows). */
export function samePath(a: string, b: string): boolean {
  const left = normalizePath(a);
  const right = normalizePath(b);
  if (left === right) return true;
  return isWindowsPath(left) && left.toLowerCase() === right.toLowerCase();
}

/**
 * The canonical form of a path: symlinks resolved, so macOS's `/var` →
 * `/private/var` alias names the same directory as its canonical path.
 * Paths that cannot be resolved (missing files, Windows-style paths on a
 * POSIX runner) are returned unchanged.
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** True when `child` is `parent` or lives inside it. */
export function isInside(parent: string, child: string): boolean {
  const from = normalizePath(parent);
  const to = normalizePath(child);
  if (from === to) return true;
  const prefix =
    from.endsWith("/") || from.endsWith("\\") ? from : `${from}${isWindowsPath(from) ? "\\" : "/"}`;
  return (
    to.startsWith(prefix) && (isWindowsPath(to) ? to.toLowerCase().startsWith(prefix.toLowerCase()) : true)
  );
}

/** Compare two directories by their canonical form. */
function sameDirectory(a: string, b: string): boolean {
  return samePath(canonicalPath(a), canonicalPath(b));
}

/** True when `child` is `parent` or lives inside it, comparing canonical forms. */
function isInsideDirectory(parent: string, child: string): boolean {
  return isInside(canonicalPath(parent), canonicalPath(child));
}

// ---------------------------------------------------------------------- //
// Locating the package                                                     //
// ---------------------------------------------------------------------- //

/** True when `dir` holds the Pi package itself. */
export function isPiPackageDir(dir: string): boolean {
  return readManifest(join(dir, "package.json"))?.name === PI_PACKAGE_NAME;
}

/** True when `path` points at an existing directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The Pi package directory for an explicit location. Accepts the package
 * directory itself, a `node_modules` root, a project directory containing
 * `node_modules`, or the path of a `pi` executable.
 */
export function piPackageDirFromLocation(location: string): string | undefined {
  const absolute = resolve(location);
  if (!isDirectory(absolute)) return packageDirFromExecutable(absolute);
  if (isPiPackageDir(absolute)) return absolute;
  const scoped = join(absolute, ...PI_PACKAGE_NAME.split("/"));
  if (isPiPackageDir(scoped)) return scoped;
  const nested = join(absolute, "node_modules", ...PI_PACKAGE_NAME.split("/"));
  if (isPiPackageDir(nested)) return nested;
  return undefined;
}

/**
 * The Pi package directory behind an executable: npm links `bin/pi` into the
 * package, so the real path walks up to the package root. Windows `.cmd`
 * shims and wrapper scripts are matched by their text instead.
 */
export function packageDirFromExecutable(file: string): string | undefined {
  let target = file;
  try {
    target = realpathSync(file);
  } catch {
    // Not a symlink (or unreadable): keep the original path.
  }
  const found = findPackageDirUpwardsFrom(dirname(target), PI_PACKAGE_NAME);
  if (found !== undefined) return found;
  const text = readTextSafe(file);
  if (text === undefined) return undefined;
  return packageDirFromText(text, dirname(file));
}

/** Walk up from a directory looking for the Pi package. */
function findPackageDirUpwardsFrom(startDir: string, name: string): string | undefined {
  let dir = resolve(startDir);
  for (let i = 0; i < 64; i += 1) {
    if (readManifest(join(dir, "package.json"))?.name === name) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function readTextSafe(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Find the Pi package path inside a script or shim. `%~dp0` (the Windows cmd
 * shim's own directory) is expanded first so the result is a real path.
 */
export function packageDirFromText(text: string, executableDir?: string): string | undefined {
  const expanded =
    executableDir === undefined ? text : text.replace(/%~dp0/gi, executableDir.replace(/\\/g, "\\\\"));
  const match = /([^\s"'<>]*?)([/\\])@earendil-works([/\\])pi-coding-agent/.exec(expanded);
  if (match === null) return undefined;
  const prefix = match[1] ?? "";
  const separator = match[2] ?? "/";
  return normalizePath(`${prefix}${separator}@earendil-works${separator}pi-coding-agent`);
}

/** The `pi` executables npm creates in a `node_modules/.bin` directory. */
export function piExecutablesIn(directory: string): string[] {
  const found: string[] = [];
  for (const name of ["pi", "pi.cmd", "pi.exe", "pi.bat", "pi.ps1"]) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) found.push(candidate);
  }
  return found;
}

/** The project directory that owns a `node_modules/<pkg>` copy. */
export function projectRootOf(packageDir: string): string {
  const absolute = packageDir.startsWith("/") || isWindowsPath(packageDir);
  const { parts, separator } = splitPath(packageDir);
  const index = parts.lastIndexOf("node_modules");
  if (index <= 0) return packageDir;
  const root = parts.slice(0, index).join(separator);
  if (!absolute) return root;
  return isWindowsPath(packageDir) ? root : `/${root}`;
}

/** True when the project that owns `packageDir` declares Pi as a dependency. */
export function projectDeclaresPi(packageDir: string): boolean {
  const root = projectRootOf(packageDir);
  const manifest = readManifest(join(root, "package.json")) as
    | {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      }
    | undefined;
  if (manifest === undefined) return false;
  return [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ].some((field) => field !== undefined && PI_PACKAGE_NAME in field);
}

// ---------------------------------------------------------------------- //
// Precedence                                                               //
// ---------------------------------------------------------------------- //

/**
 * Pick the Pi installation to run, following the documented precedence.
 *
 * An explicit location is exclusive: when it does not hold a Pi installation
 * the resolution fails instead of silently using another copy.
 */
export function resolvePiPackage(context: ResolveContext): ResolveResult {
  const rejections: PiRejection[] = [];
  const peer = context.adapterPeerPackageDir;

  if (context.explicit !== undefined && context.explicit !== "") {
    const packageDir = piPackageDirFromLocation(context.explicit);
    if (packageDir === undefined) {
      throw new PiLocationError(
        context.explicit,
        `no ${PI_PACKAGE_NAME} installation found at ${context.explicit}`,
      );
    }
    return {
      selected: { source: "explicit", packageDir, detail: context.explicit },
      rejections,
    };
  }

  const project = findProjectPackage(context.cwd);
  if (project !== undefined) {
    if (peer !== undefined && sameDirectory(project, peer) && !projectDeclaresPi(project)) {
      rejections.push({
        packageDir: project,
        source: "project",
        reason: "installed automatically as this package's peer dependency, not chosen by you",
      });
    } else {
      return {
        selected: { source: "project", packageDir: project, detail: context.cwd },
        rejections,
      };
    }
  }

  for (const entry of context.pathEntries) {
    if (entry === "") continue;
    for (const executable of piExecutablesIn(entry)) {
      const packageDir = packageDirFromExecutable(executable);
      if (packageDir === undefined) continue;
      if (peer !== undefined && sameDirectory(packageDir, peer)) {
        rejections.push({
          packageDir,
          source: "path",
          reason: "installed automatically as this package's peer dependency, not chosen by you",
        });
        continue;
      }
      if (
        context.adapterPackageDir !== undefined &&
        isInsideDirectory(context.adapterPackageDir, packageDir) &&
        !sameDirectory(packageDir, context.adapterPackageDir)
      ) {
        rejections.push({
          packageDir,
          source: "path",
          reason: "inside this package's own installation",
        });
        continue;
      }
      return {
        selected: { source: "path", packageDir, detail: executable },
        rejections,
      };
    }
  }

  const root = context.adapterNodeModulesRoot;
  if (root !== undefined) {
    const packageDir = join(root, ...PI_PACKAGE_NAME.split("/"));
    if (
      isPiPackageDir(packageDir) &&
      (peer === undefined || !sameDirectory(packageDir, peer)) &&
      (context.adapterPackageDir === undefined ||
        !isInsideDirectory(context.adapterPackageDir, packageDir) ||
        sameDirectory(packageDir, context.adapterPackageDir))
    ) {
      return {
        selected: { source: "global", packageDir, detail: root },
        rejections,
      };
    }
  }

  return { rejections };
}

/** The Pi package the working directory resolves to, if any. */
function findProjectPackage(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (let i = 0; i < 64; i += 1) {
    const candidate = join(dir, "node_modules", ...PI_PACKAGE_NAME.split("/"));
    if (isPiPackageDir(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** Separator of the current platform, exported for path-shape assertions. */
export const PLATFORM_SEPARATOR = sep;
