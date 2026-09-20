/**
 * Extension-authored session entries → ACP metadata (pure).
 *
 * `pi.sendMessage({ customType, content, details })` and
 * `pi.appendEntry(customType, data)` are how extensions put their own state
 * into the transcript. Their shape is private to each extension; the adapter
 * forwards them whole (JSON-safe, size-bounded) so a client can adapt a given
 * extension without the adapter knowing it.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sanitizePayload } from "./extension-events.ts";
import { piMeta } from "./meta.ts";
import { toolResultText } from "./tool-facts.ts";
import type { SessionUpdate } from "./translate.ts";

export interface CustomMessageLike {
  customType: string;
  content: unknown;
  display: boolean;
  details?: unknown;
}

function contentText(content: unknown): string {
  return typeof content === "string" ? content : toolResultText({ content });
}

export function customMessageUpdate(message: CustomMessageLike, entryId?: string): SessionUpdate {
  const content = sanitizePayload(message.content);
  const details = message.details === undefined ? undefined : sanitizePayload(message.details);
  return {
    sessionUpdate: "session_info_update",
    _meta: piMeta({
      event: "custom_message",
      customType: message.customType,
      display: message.display,
      text: contentText(message.content),
      content: content.payload,
      ...(details !== undefined ? { details: details.payload } : {}),
      truncated: content.truncated || details?.truncated === true,
      ...(entryId !== undefined ? { entryId } : {}),
    }),
  };
}

export function customEntryUpdate(customType: string, data: unknown, entryId?: string): SessionUpdate {
  const payload = data === undefined ? undefined : sanitizePayload(data);
  return {
    sessionUpdate: "session_info_update",
    _meta: piMeta({
      event: "custom_entry",
      customType,
      ...(payload !== undefined ? { data: payload.payload } : {}),
      truncated: payload?.truncated === true,
      ...(entryId !== undefined ? { entryId } : {}),
    }),
  };
}

/** Updates for an extension-authored entry; empty for every other entry type. */
export function customEntryUpdates(entry: SessionEntry): SessionUpdate[] {
  switch (entry.type) {
    case "custom_message":
      return [
        customMessageUpdate(
          {
            customType: entry.customType,
            content: entry.content,
            display: entry.display,
            details: entry.details,
          },
          entry.id,
        ),
      ];
    case "custom":
      return [customEntryUpdate(entry.customType, entry.data, entry.id)];
    case "message": {
      const message = entry.message as { role: string } & Partial<CustomMessageLike>;
      if (message.role !== "custom" || typeof message.customType !== "string") return [];
      return [
        customMessageUpdate(
          {
            customType: message.customType,
            content: message.content,
            display: message.display === true,
            details: message.details,
          },
          entry.id,
        ),
      ];
    }
    default:
      return [];
  }
}
