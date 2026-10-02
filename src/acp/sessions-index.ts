/**
 * Session discovery on pi's own store (`~/.pi/agent/sessions/**.jsonl`).
 *
 * pi's `SessionManager.list/listAll` parse every file fully; for `session/list`
 * we use them (they carry name, cwd, timestamps) and filter by cwd when asked.
 */

import type { SessionInfo } from "@agentclientprotocol/sdk";
import { SessionManager, type SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { logDebug } from "../log.ts";
import { persistedAdditionalDirectories } from "./workspace-scope.ts";

export interface SessionIndexEntry {
  sessionId: string;
  cwd: string;
  path: string;
  title: string | undefined;
  updatedAt: string;
  /** Canonical additional roots persisted on the session branch. Empty when none were stored. */
  additionalDirectories: string[];
}

function toEntry(info: PiSessionInfo): SessionIndexEntry {
  const title = info.name?.trim() || info.firstMessage?.trim().split("\n", 1)[0]?.slice(0, 80) || undefined;
  return {
    sessionId: info.id,
    cwd: info.cwd,
    path: info.path,
    title: title !== undefined && title.length > 0 ? title : undefined,
    updatedAt: info.modified.toISOString(),
    additionalDirectories: readPersistedDirectories(info.path),
  };
}

function readPersistedDirectories(sessionFile: string): string[] {
  let text: string;
  try {
    text = readFileSync(sessionFile, "utf8");
  } catch {
    return [];
  }
  const entries: {
    type: string;
    id?: string;
    parentId?: string | null;
    customType?: string;
    data?: unknown;
  }[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as {
        type?: unknown;
        id?: unknown;
        parentId?: unknown;
        customType?: unknown;
        data?: unknown;
      };
      if (typeof parsed.type !== "string") continue;
      entries.push({
        type: parsed.type,
        ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
        ...(typeof parsed.parentId === "string" || parsed.parentId === null
          ? { parentId: parsed.parentId }
          : {}),
        ...(typeof parsed.customType === "string" ? { customType: parsed.customType } : {}),
        ...(parsed.data !== undefined ? { data: parsed.data } : {}),
      });
    } catch {
      // A torn last line is ignored; earlier entries still describe the branch.
    }
  }
  return persistedAdditionalDirectories(entries);
}

export async function listSessions(options: {
  cwd?: string;
  sessionDir?: string;
}): Promise<SessionIndexEntry[]> {
  const infos =
    options.cwd !== undefined
      ? await SessionManager.list(options.cwd, options.sessionDir)
      : await SessionManager.listAll(options.sessionDir);
  return infos.map(toEntry).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function findSession(
  sessionId: string,
  sessionDir?: string,
): Promise<SessionIndexEntry | undefined> {
  const all = await SessionManager.listAll(sessionDir);
  const found = all.find((info) => info.id === sessionId);
  if (found === undefined) logDebug(`session ${sessionId} not found in pi's session store`);
  return found === undefined ? undefined : toEntry(found);
}

export function toAcpSessionInfo(entry: SessionIndexEntry): SessionInfo {
  return {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    additionalDirectories: entry.additionalDirectories,
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    updatedAt: entry.updatedAt,
  };
}
