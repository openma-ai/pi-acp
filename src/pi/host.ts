/**
 * Loading the Pi installation the user chose.
 *
 * The adapter never resolves Pi for itself: it locates the installation the
 * user installed (see `resolve.ts`), checks its version against the supported
 * range, and imports that exact copy. Nothing else is loaded — in particular
 * not npm's auto-installed peer copy inside this package's own tree.
 */

import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { satisfies } from "semver";
import { installPiSdk, type PiApi, type PiInstallation } from "./api.ts";
import {
  ownNodeModulesRoot,
  ownPackageDir,
  ownPeerPackageDir,
  PI_PACKAGE_NAME,
  readManifest,
} from "./paths.ts";
import { PiLocationError, resolvePiPackage, type PiCandidate, type PiRejection } from "./resolve.ts";

/**
 * The Pi versions this adapter supports. Mirrors the `peerDependencies` range
 * in `package.json` (a unit test keeps the two in sync).
 */
export const PI_SUPPORTED_RANGE = ">=1.3.0 <2";

/** Exports the adapter needs from the Pi SDK. */
const REQUIRED_EXPORTS = [
  "AgentSessionRuntime",
  "ModelRuntime",
  "ProjectTrustStore",
  "SessionManager",
  "SettingsManager",
  "createAgentSessionFromServices",
  "createAgentSessionRuntime",
  "createAgentSessionServices",
  "createEventBus",
  "createMcpExtension",
  "createToolSearchExtension",
  "getAgentDir",
  "getPackageDir",
  "resolveCliModel",
] as const;

export class PiNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiNotFoundError";
  }
}

export class PiVersionError extends Error {
  constructor(
    readonly found: string,
    readonly range: string,
    message: string,
  ) {
    super(message);
    this.name = "PiVersionError";
  }
}

export interface LoadPiOptions {
  /** Explicit package location (`--pi-package-dir` / `PI_ACP_PI_PACKAGE_DIR`). */
  explicit?: string | undefined;
  /** Working directory the adapter runs in. */
  cwd?: string | undefined;
  /** `PATH` entries to scan for the `pi` executable. */
  pathEntries?: readonly string[] | undefined;
}

/**
 * Locate, validate, and load the user's Pi installation.
 *
 * Throws `PiNotFoundError` when no installation is found and `PiVersionError`
 * when the found version is outside `PI_SUPPORTED_RANGE`. Neither falls back
 * to another copy.
 */
export async function loadPiHost(options: LoadPiOptions = {}): Promise<PiInstallation & { api: PiApi }> {
  let selected: PiCandidate | undefined;
  let rejections: PiRejection[] = [];
  try {
    const resolved = resolvePiPackage({
      explicit: options.explicit,
      cwd: options.cwd ?? process.cwd(),
      pathEntries: options.pathEntries ?? (process.env["PATH"] ?? "").split(delimiter),
      adapterPackageDir: ownPackageDir(),
      adapterNodeModulesRoot: ownNodeModulesRoot(),
      adapterPeerPackageDir: ownPeerPackageDir(),
    });
    selected = resolved.selected;
    rejections = resolved.rejections;
  } catch (error: unknown) {
    if (error instanceof PiLocationError) {
      throw new PiNotFoundError(
        [
          `openma-pi-acp could not find a ${PI_PACKAGE_NAME} installation at ${error.location}.`,
          "",
          ...installHint(),
        ].join("\n"),
      );
    }
    throw error;
  }
  if (selected === undefined) throw new PiNotFoundError(notFoundMessage(rejections));

  const version = readPiVersion(selected.packageDir);
  if (version === undefined) {
    throw new PiNotFoundError(
      `the Pi installation at ${selected.packageDir} has no readable version in package.json`,
    );
  }
  if (!satisfies(version, PI_SUPPORTED_RANGE)) {
    throw new PiVersionError(
      version,
      PI_SUPPORTED_RANGE,
      `openma-pi-acp found Pi ${version} at ${selected.packageDir}, which is outside the supported range ${PI_SUPPORTED_RANGE}.`,
    );
  }

  const api = await importPi(selected.packageDir);
  const missing = REQUIRED_EXPORTS.filter((name) => !(name in api));
  if (missing.length > 0) {
    throw new PiVersionError(
      version,
      PI_SUPPORTED_RANGE,
      `the Pi installation at ${selected.packageDir} (version ${version}) does not export ${missing.join(", ")}; it is not compatible with this adapter.`,
    );
  }

  const installation: PiInstallation = {
    version,
    packageDir: selected.packageDir,
    source: selected.source,
    detail: selected.detail,
  };
  installPiSdk(api, installation);
  return { ...installation, api };
}

/** The version of a Pi installation, from its `package.json`. */
export function readPiVersion(packageDir: string): string | undefined {
  const manifest = readManifest(join(packageDir, "package.json"));
  return typeof manifest?.version === "string" ? manifest.version : undefined;
}

/** The ESM entry point of a Pi installation. */
export function resolvePiEntry(packageDir: string): string {
  const manifest = readManifest(join(packageDir, "package.json")) as
    { exports?: Record<string, unknown>; module?: string; main?: string } | undefined;
  const target =
    pickExportTarget(manifest?.exports?.["."]) ?? manifest?.module ?? manifest?.main ?? "./index.js";
  return join(packageDir, target);
}

/** Pick the `import` condition out of an `exports` entry. */
function pickExportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const condition of ["import", "node", "default"]) {
    const nested = record[condition];
    if (nested === undefined) continue;
    const resolved = pickExportTarget(nested);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/** Import a Pi installation by its entry point, so its siblings load with it. */
async function importPi(packageDir: string): Promise<PiApi> {
  const entry = resolvePiEntry(packageDir);
  try {
    return (await import(pathToFileURL(entry).href)) as PiApi;
  } catch (error: unknown) {
    throw new PiNotFoundError(
      `could not load the Pi installation at ${packageDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The message shown when no Pi installation was found. */
function notFoundMessage(rejections: readonly PiRejection[]): string {
  const lines = [`openma-pi-acp could not find a ${PI_PACKAGE_NAME} installation.`, "", ...installHint()];
  if (rejections.length > 0) {
    lines.push("", "Looked at:");
    for (const rejection of rejections) {
      lines.push(`  ${rejection.packageDir} — ${rejection.reason}`);
    }
  }
  return lines.join("\n");
}

/** How to install the Pi version the user wants. */
function installHint(): string[] {
  return [
    "The Pi SDK is a peer dependency: you choose which Pi version runs behind this adapter.",
    `Supported versions: ${PI_SUPPORTED_RANGE}.`,
    "",
    "Install the version you want:",
    "  npm install @earendil-works/pi-coding-agent@1.5.2      # in your project",
    "  npm install -g @earendil-works/pi-coding-agent@1.5.2   # globally",
    "",
    "Or point at an existing installation:",
    "  openma-pi-acp --pi-package-dir <dir>",
    "  PI_ACP_PI_PACKAGE_DIR=<dir> openma-pi-acp",
  ];
}
