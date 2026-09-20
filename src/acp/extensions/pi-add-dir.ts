/**
 * `pi-add-dir` → ACP `additionalDirectories`.
 *
 * The extension owns the feature: `/add-dir <path>` records the directory in a
 * `custom` session entry (`add-dir:state`, `{ dirs: [{ absolutePath, label,
 * addedAt }] }`), injects its AGENTS.md/CLAUDE.md into the system prompt, and
 * registers its skills. The adapter drives it exactly like a user would (the
 * slash command through `session.prompt`) and reads its state entry back.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve } from "node:path";
import { errorMessage, logWarn } from "../../log.ts";

export const ADD_DIR_STATE_ENTRY = "add-dir:state";
export const ADD_DIR_COMMAND = "add-dir";

interface AddedDir {
  absolutePath: string;
}

/** Directories the extension currently tracks for this session (last state entry on the branch wins). */
export function readAddedDirectories(session: AgentSession): string[] {
  let dirs: string[] = [];
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== ADD_DIR_STATE_ENTRY) continue;
    const data = entry.data as { dirs?: AddedDir[] } | undefined;
    dirs = (data?.dirs ?? [])
      .map((dir) => dir?.absolutePath)
      .filter((path): path is string => typeof path === "string" && path.length > 0);
  }
  return dirs;
}

/**
 * Add every requested directory the extension does not track yet. Returns
 * human-readable problems for entries that were skipped or rejected.
 */
export async function applyAdditionalDirectories(
  session: AgentSession,
  cwd: string,
  requested: readonly string[] | null | undefined,
): Promise<string[]> {
  const problems: string[] = [];
  if (requested === undefined || requested === null || requested.length === 0) return problems;
  const primary = resolve(cwd);
  const current = new Set(readAddedDirectories(session));
  for (const raw of requested) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    if (!isAbsolute(raw)) {
      problems.push(`additional directory ${raw} skipped: not an absolute path`);
      continue;
    }
    const path = resolve(raw);
    if (path === primary || current.has(path)) continue;
    try {
      // The extension command runs synchronously inside prompt() and never reaches the model.
      await session.prompt(`/${ADD_DIR_COMMAND} ${path}`, { expandPromptTemplates: true });
      current.add(path);
    } catch (error: unknown) {
      logWarn(`/${ADD_DIR_COMMAND} ${path} failed: ${errorMessage(error)}`);
      problems.push(`additional directory ${path} rejected: ${errorMessage(error)}`);
    }
  }
  return problems;
}
