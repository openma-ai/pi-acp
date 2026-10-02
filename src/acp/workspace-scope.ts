/**
 * ACP `additionalDirectories` as a filesystem scope around the session `cwd`.
 *
 * Pi has one project root: skills, prompt templates, and AGENTS.md stay on `cwd`.
 * Extra roots only widen the path boundary used by read/write/edit/grep/find/ls/bash.
 * The capability is advertised only when that boundary check actually works.
 */

import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { isAbsolute, dirname, join, parse, relative, sep } from "node:path";
import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";

/** Session entry that stores the ordered additional-root list on the active branch. */
export const ADDITIONAL_DIRECTORIES_ENTRY = "pi-acp:additional-directories";
/** Cap for lifecycle requests and `_pi/add_directory`, matching the issue's /add-dir bound. */
export const MAX_ADDITIONAL_DIRECTORIES = 16;
const SCOPE_EXTENSION = "pi-acp-workspace-scope";

const SHELL_DEVICES = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/stdin",
  "/dev/tty",
  "/dev/zero",
]);

export class AdditionalDirectoriesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdditionalDirectoriesError";
  }
}

export interface DirectoryPlan {
  /** `restore` reloads the list persisted on the session branch. */
  kind: "explicit" | "restore" | "ignored";
  directories: string[];
  warning?: string;
}

interface LooseEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  customType?: string;
  data?: unknown;
}

let supportedCache: boolean | undefined;

/** True only when a real temp-directory probe shows the scope check accepts inside and rejects outside. */
export function additionalDirectoriesSupported(): boolean {
  if (supportedCache !== undefined) return supportedCache;
  const probe = mkdtempSync(join(tmpdir(), "pi-acp-scope-"));
  try {
    const inside = join(probe, "inside");
    const outside = join(probe, "outside");
    mkdirSync(inside);
    mkdirSync(outside);
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "secret\n");
    const scope = new WorkspaceScope(inside);
    const created = scope.denial(join(inside, "new.txt"));
    const leaked = scope.denial(secret);
    supportedCache = created === undefined && leaked !== undefined;
  } catch {
    supportedCache = false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  return supportedCache;
}

/** `{}` when the scope check works; omit the capability otherwise. */
export function additionalDirectoriesCapability(): Record<string, never> | undefined {
  return additionalDirectoriesSupported() ? {} : undefined;
}

/**
 * Turn a lifecycle `additionalDirectories` value into a plan.
 * Unsupported agents warn and ignore, matching the pre-capability behaviour.
 * An omitted field restores the persisted list when `restoreWhenOmitted` is set
 * (`session/load`, `session/resume`, `session/fork`); `session/new` treats omit as none.
 * An empty array clears. Malformed or unauthorized entries reject the whole request.
 */
export function resolveAdditionalDirectoriesRequest(
  requested: readonly string[] | null | undefined,
  cwd: string,
  options: { supported: boolean; restoreWhenOmitted: boolean },
): DirectoryPlan {
  const omitted = requested === undefined || requested === null;
  if (!options.supported) {
    if (!omitted && requested.length > 0) {
      return {
        kind: "ignored",
        directories: [],
        warning: `additionalDirectories ignored (${requested.join(", ")}): workspace scope is unavailable`,
      };
    }
    return { kind: "ignored", directories: [] };
  }
  if (omitted) {
    return options.restoreWhenOmitted
      ? { kind: "restore", directories: [] }
      : { kind: "explicit", directories: [] };
  }
  return { kind: "explicit", directories: validateAdditionalDirectories(requested, cwd) };
}

/** Canonical additional roots. Drops exact `cwd` duplicates. Throws on any entry that cannot be granted. */
export function validateAdditionalDirectories(requested: readonly string[], cwd: string): string[] {
  if (!Array.isArray(requested)) {
    throw new AdditionalDirectoriesError("additionalDirectories must be an array of absolute paths");
  }
  const primary = canonicalizeExistingDirectory(cwd);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of requested) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new AdditionalDirectoriesError("additionalDirectories entries must be non-empty strings");
    }
    if (!isAbsolute(entry)) {
      throw new AdditionalDirectoriesError(`additional directory must be an absolute path: ${entry}`);
    }
    if (isFilesystemRoot(entry)) {
      throw new AdditionalDirectoriesError(`additional directory must not be a filesystem root: ${entry}`);
    }
    let canonical: string;
    try {
      canonical = canonicalizeExistingDirectory(entry);
    } catch {
      throw new AdditionalDirectoriesError(`additional directory is not an existing directory: ${entry}`);
    }
    if (isFilesystemRoot(canonical)) {
      throw new AdditionalDirectoriesError(`additional directory must not be a filesystem root: ${entry}`);
    }
    if (canonical === homeDirectory()) {
      throw new AdditionalDirectoriesError(`additional directory must not be the home directory: ${entry}`);
    }
    if (canonical === primary || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
    if (out.length > MAX_ADDITIONAL_DIRECTORIES) {
      throw new AdditionalDirectoriesError(
        `additionalDirectories accepts at most ${MAX_ADDITIONAL_DIRECTORIES} roots`,
      );
    }
  }
  return out;
}

export function isFilesystemRoot(filePath: string): boolean {
  try {
    const resolved = realpathSync(filePath);
    return resolved === parse(resolved).root;
  } catch {
    const { root } = parse(filePath);
    const normalized = filePath.endsWith(sep) ? filePath.slice(0, -1) || root : filePath;
    return normalized === root || filePath === root;
  }
}

/** Latest `pi-acp:additional-directories` entry on the active branch (leaf → root). */
export function persistedAdditionalDirectories(entries: readonly LooseEntry[]): string[] {
  let leaf: LooseEntry | undefined;
  const byId = new Map<string, LooseEntry>();
  for (const entry of entries) {
    if (entry.type === "session" || typeof entry.id !== "string") continue;
    byId.set(entry.id, entry);
    leaf = entry;
  }
  const seen = new Set<string>();
  let current = leaf;
  while (current !== undefined) {
    if (typeof current.id === "string") {
      if (seen.has(current.id)) break;
      seen.add(current.id);
    }
    if (current.type === "custom" && current.customType === ADDITIONAL_DIRECTORIES_ENTRY) {
      return directoriesFromData(current.data);
    }
    current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
  }
  return [];
}

export class WorkspaceScope {
  readonly cwd: string;
  private extra: string[] = [];

  constructor(cwd: string) {
    this.cwd = canonicalizeExistingDirectory(cwd);
  }

  get additionalDirectories(): string[] {
    return [...this.extra];
  }

  get roots(): string[] {
    return [this.cwd, ...this.extra];
  }

  setAdditional(directories: readonly string[]): void {
    this.extra = [...directories];
  }

  /** `undefined` when `input` is inside a root. Relative paths resolve against `cwd`. */
  denial(input: string): string | undefined {
    let canonical: string;
    try {
      canonical = canonicalAccessPath(input, this.cwd);
    } catch (error: unknown) {
      return error instanceof Error ? error.message : `path cannot be resolved safely: ${input}`;
    }
    if (this.roots.some((root) => isInsideRoot(root, canonical))) return undefined;
    return `path is outside the session workspace: ${canonical}`;
  }

  /** `undefined` when every path the command names is inside a root (or a shell device). */
  shellDenial(command: string): string | undefined {
    const scan = shellAccessPaths(command);
    if (scan.unverifiable.length > 0) {
      return `command references a path the session cannot verify: ${scan.unverifiable[0]}`;
    }
    for (const candidate of scan.paths) {
      if (isShellDevice(candidate)) continue;
      const reason = this.denial(candidate);
      if (reason === undefined) continue;
      return `command references a path outside the session workspace: ${candidate}`;
    }
    return undefined;
  }
}

export function workspaceScopeExtension(scope: WorkspaceScope): InlineExtension {
  const factory: ExtensionFactory = (pi) => {
    pi.on("tool_call", (event) => {
      const reason = toolScopeDenial(event.toolName, event.input, scope);
      if (reason !== undefined) return { block: true, reason };
      return undefined;
    });
    pi.on("before_agent_start", (event) => {
      const extra = scope.additionalDirectories;
      if (extra.length === 0) return undefined;
      const note = [
        "Additional workspace roots are in filesystem scope for read, write, edit, grep, find, ls, and bash.",
        "They are not project roots: skills and AGENTS.md stay on the primary working directory.",
        "Relative paths still resolve against the primary working directory.",
        ...extra.map((dir) => `- ${dir}`),
      ].join("\n");
      return { systemPrompt: `${event.systemPrompt}\n\n${note}` };
    });
  };
  return { name: SCOPE_EXTENSION, hidden: true, factory };
}

export function scopeExtensionLoaded(paths: readonly string[]): boolean {
  return paths.some((path) => path.includes(SCOPE_EXTENSION));
}

export function toolScopeDenial(toolName: string, input: unknown, scope: WorkspaceScope): string | undefined {
  const record = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  switch (toolName) {
    case "read":
    case "write":
    case "edit":
    case "grep":
    case "find":
    case "ls": {
      const path = record["path"];
      if (typeof path !== "string" || path.length === 0) {
        if (toolName === "grep" || toolName === "find" || toolName === "ls") return undefined;
        return "path is outside the session workspace: (missing path)";
      }
      return scope.denial(path);
    }
    case "bash":
    case "powershell": {
      const command = record["command"];
      if (typeof command !== "string")
        return "command references a path the session cannot verify: (missing command)";
      return scope.shellDenial(command);
    }
    default:
      return undefined;
  }
}

export function shellAccessPaths(command: string): { paths: string[]; unverifiable: string[] } {
  const paths: string[] = [];
  const unverifiable: string[] = [];
  const seen = new Set<string>();
  let word = "";
  let quote: "'" | '"' | undefined;
  let quoted = "";
  let redirect = false;

  const take = (candidate: string, asRedirect: boolean, nested = false): void => {
    if (candidate.length === 0 || seen.has(candidate)) return;
    if (candidate.includes("$") || candidate.includes("`") || /^~[^/\\]/.test(candidate)) {
      seen.add(candidate);
      unverifiable.push(candidate);
      return;
    }
    if (asRedirect || isPathLike(candidate)) {
      seen.add(candidate);
      paths.push(candidate);
    }
    if (!nested) {
      for (const piece of absolutePieces(candidate)) {
        if (piece !== candidate) take(piece, false, true);
      }
    }
  };

  const emit = (): void => {
    if (word.length === 0) return;
    const token = word;
    const asRedirect = redirect;
    word = "";
    redirect = false;
    if (token.startsWith("-") && !asRedirect) {
      const eq = token.indexOf("=");
      if (eq !== -1) take(token.slice(eq + 1), false);
      return;
    }
    take(token, asRedirect);
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote !== undefined) {
      if (ch === quote) {
        if (isPathLike(quoted)) take(quoted, false);
        quoted = "";
        quote = undefined;
      } else if (quote === '"' && ch === "\\" && i + 1 < command.length) {
        const next = command[i + 1]!;
        word += next;
        quoted += next;
        i += 1;
      } else {
        word += ch;
        quoted += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = "";
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < command.length) {
        word += command[i + 1];
        i += 1;
      }
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      emit();
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
      emit();
      continue;
    }
    if ((ch === ">" || ch === "<") && (/^\d+$/.test(word) || word === "&" || word.length === 0)) {
      word = "";
      redirect = true;
      while (i + 1 < command.length && (command[i + 1] === ">" || command[i + 1] === "<")) i += 1;
      continue;
    }
    word += ch;
  }
  emit();
  return { paths, unverifiable };
}

function directoriesFromData(data: unknown): string[] {
  if (data === null || typeof data !== "object") return [];
  const dirs = (data as { directories?: unknown }).directories;
  if (!Array.isArray(dirs)) return [];
  return dirs.filter((dir): dir is string => typeof dir === "string" && dir.length > 0);
}

function homeDirectory(): string | undefined {
  const home = homedir();
  if (home.length === 0) return undefined;
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
}

function canonicalizeExistingDirectory(filePath: string): string {
  const real = realpathSync(filePath);
  if (!statSync(real).isDirectory()) throw new Error("not a directory");
  return real;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isPathLike(token: string): boolean {
  if (token.length === 0 || /\s/.test(token)) return false;
  if (token.startsWith("-")) return false;
  return (
    token.startsWith("/") ||
    token.startsWith("~") ||
    token.startsWith(".") ||
    token.includes("/") ||
    token.includes("\\") ||
    token.includes("..")
  );
}

/** Absolute paths named inside a larger word, such as open("/etc/passwd"). */
function absolutePieces(text: string): string[] {
  const pieces: string[] = [];
  for (const match of text.matchAll(/(?:\/|~\/)[^\s"'`)<>|&;]+/g)) {
    const piece = match[0];
    if (piece !== undefined && piece.length > 1) pieces.push(piece);
  }
  return pieces;
}

function isShellDevice(filePath: string): boolean {
  if (SHELL_DEVICES.has(filePath)) return true;
  return filePath.startsWith("/dev/fd/");
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    const home = homedir().replace(/[/\\]+$/, "");
    return `${home}/${input.slice(2)}`;
  }
  return input;
}

function joinRelative(cwd: string, relativePath: string): string {
  const prefix = cwd.endsWith(sep) ? cwd : `${cwd}${sep}`;
  return prefix + relativePath;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Resolve `input` against `cwd` without letting lexical `..` skip a symlink. Fail closed on broken links. */
export function canonicalAccessPath(input: string, cwd: string): string {
  const expanded = expandHome(input);
  if (expanded.startsWith("~")) throw new Error(`path cannot be resolved safely: ${input}`);
  const absolute = isAbsolute(expanded) ? expanded : joinRelative(cwd, expanded);
  if (!isAbsolute(absolute)) throw new Error(`path cannot be resolved safely: ${input}`);
  const root = parse(absolute).root;
  const parts = absolute
    .slice(root.length)
    .split(/[/\\]/)
    .filter((part) => part.length > 0);
  let current = root;
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      const parent = dirname(current);
      current = parent.length >= root.length ? parent : root;
      continue;
    }
    const next = current.endsWith(sep) ? `${current}${part}` : `${current}${sep}${part}`;
    let linked = false;
    try {
      linked = lstatSync(next).isSymbolicLink();
    } catch (error: unknown) {
      if (isEnoent(error)) {
        current = next;
        continue;
      }
      throw new Error(`path cannot be resolved safely: ${input}`);
    }
    if (linked) {
      try {
        current = realpathSync(next);
      } catch {
        throw new Error(`path cannot be resolved safely: ${input}`);
      }
      continue;
    }
    try {
      current = realpathSync(next);
    } catch (error: unknown) {
      if (isEnoent(error)) {
        current = next;
        continue;
      }
      throw new Error(`path cannot be resolved safely: ${input}`);
    }
  }
  return current;
}
