/**
 * Session discovery on pi's own store (`~/.pi/agent/sessions/**.jsonl`).
 *
 * pi's `SessionManager.list/listAll` parse every file fully; for `session/list`
 * we use them (they carry name, cwd, timestamps) and filter by cwd when asked.
 */

import type { SessionInfo } from "@agentclientprotocol/sdk";
import { SessionManager, type SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { logDebug } from "../log.ts";

export interface SessionIndexEntry {
  sessionId: string;
  cwd: string;
  path: string;
  title: string | undefined;
  updatedAt: string;
}

function toEntry(info: PiSessionInfo): SessionIndexEntry {
  const title = info.name?.trim() || info.firstMessage?.trim().split("\n", 1)[0]?.slice(0, 80) || undefined;
  return {
    sessionId: info.id,
    cwd: info.cwd,
    path: info.path,
    title: title !== undefined && title.length > 0 ? title : undefined,
    updatedAt: info.modified.toISOString(),
  };
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
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    updatedAt: entry.updatedAt,
  };
}
