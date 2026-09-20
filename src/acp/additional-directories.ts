/**
 * ACP `additionalDirectories` for a single-root pi session.
 *
 * pi has one workspace root (`cwd`). Extra roots are honoured the way pi itself
 * honours the primary root: the model is told they exist and their project
 * context files (AGENTS.md etc., resolved by pi's own loader) are appended to
 * the system prompt for every turn. Tools already accept absolute paths, so no
 * sandboxing changes are needed.
 */

import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { errorMessage, logDebug } from "../log.ts";

export interface AdditionalDirectoryProblem {
  path: string;
  reason: string;
}

/** Normalize, dedupe, and drop the primary cwd; reports unusable entries. */
export function resolveAdditionalDirectories(
  cwd: string,
  requested: readonly string[] | undefined,
): { directories: string[]; problems: AdditionalDirectoryProblem[] } {
  const directories: string[] = [];
  const problems: AdditionalDirectoryProblem[] = [];
  const primary = resolve(cwd);
  for (const raw of requested ?? []) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    if (!isAbsolute(raw)) {
      problems.push({ path: raw, reason: "not an absolute path" });
      continue;
    }
    const path = resolve(raw);
    if (path === primary || directories.includes(path)) continue;
    try {
      if (!statSync(path).isDirectory()) {
        problems.push({ path, reason: "not a directory" });
        continue;
      }
    } catch {
      problems.push({ path, reason: existsSync(path) ? "not readable" : "does not exist" });
      continue;
    }
    directories.push(path);
  }
  return { directories, problems };
}

/** System-prompt section describing the extra roots and their context files. */
export function additionalDirectoriesPrompt(directories: readonly string[], agentDir: string): string {
  if (directories.length === 0) return "";
  const lines: string[] = [
    "# Additional workspace directories",
    "",
    "Besides the working directory, the user has opened these directories as part of the workspace. Treat them as in scope and use absolute paths when reading or editing files in them:",
    "",
    ...directories.map((directory) => `- ${directory}`),
  ];
  for (const directory of directories) {
    let files: { path: string; content: string }[] = [];
    try {
      files = loadProjectContextFiles({ cwd: directory, agentDir });
    } catch (error: unknown) {
      logDebug(`context files for ${directory} failed: ${errorMessage(error)}`);
    }
    for (const file of files) {
      if (file.content.trim().length === 0) continue;
      lines.push("", `## Context from ${file.path}`, "", file.content.trim());
    }
  }
  return lines.join("\n");
}
