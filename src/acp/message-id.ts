/**
 * Stable ACP `messageId` for an assistant message.
 *
 * Pi assigns the entry id only when the message is appended, which is after
 * streaming finishes. The parent entry (the user message, or the previous tool
 * result) is already on disk when the first token arrives. The id is
 * `<parentEntryId>:<ordinal>`, where ordinal is the 1-based file order of this
 * assistant among assistant children of that parent. Replay recomputes the
 * same string from the session tree. `root` stands in for a missing parent.
 */

import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export function formatAssistantMessageId(parentId: string | null, ordinal: number): string {
  return `${parentId ?? "root"}:${ordinal}`;
}

function isAssistantEntry(entry: SessionEntry): entry is SessionMessageEntry {
  return entry.type === "message" && entry.message.role === "assistant";
}

/** Id for an assistant entry already stored in `entries` (file order). */
export function assistantAcpMessageId(entry: SessionMessageEntry, entries: readonly SessionEntry[]): string {
  let ordinal = 0;
  for (const candidate of entries) {
    if (!isAssistantEntry(candidate) || candidate.parentId !== entry.parentId) continue;
    ordinal += 1;
    if (candidate.id === entry.id) return formatAssistantMessageId(entry.parentId, ordinal);
  }
  return formatAssistantMessageId(entry.parentId, ordinal + 1);
}

/**
 * Id for the assistant message that is about to stream. `parentId` is the
 * current leaf, persisted before `message_start`.
 */
export function nextAssistantMessageId(parentId: string | null, entries: readonly SessionEntry[]): string {
  let ordinal = 0;
  for (const entry of entries) {
    if (isAssistantEntry(entry) && entry.parentId === parentId) ordinal += 1;
  }
  return formatAssistantMessageId(parentId, ordinal + 1);
}
