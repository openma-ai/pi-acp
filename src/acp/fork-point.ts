/**
 * Inclusive `session/fork` via `_meta.jetbrains.air.fork` v1.
 *
 * Parsing and point location are pure. Truncation uses pi's
 * `SessionManager.createBranchedSession` — the same cut
 * `AgentSessionRuntime.fork(entryId, { position: "at" })` performs — on a
 * manager opened from the source file, so the live source session is left
 * alone.
 */

import { createHash } from "node:crypto";
import { SessionManager, type SessionEntry, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assistantAcpMessageId } from "./message-id.ts";

export const FORK_UNSUPPORTED_VERSION = "Unsupported jetbrains.air.fork version";
export const FORK_MESSAGE_ID = "jetbrains.air.fork messageId must be a non-empty string";
export const FORK_FINGERPRINT = "jetbrains.air.fork messageFingerprint must match sha256:<64 lowercase hex>";
export const FORK_OCCURRENCE = "jetbrains.air.fork messageOccurrence must be a positive safe integer";

const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SEGMENT_SUFFIX = /:segment:\d+$/;

export interface InclusiveForkRequest {
  /** Trimmed assistant message id from `agent_message_chunk`. */
  messageId: string;
  messageFingerprint?: string;
  /** 1-based. Defaults to 1 when the client omits it. */
  messageOccurrence: number;
}

export type ParsedForkMeta =
  | { status: "absent" }
  | { status: "invalid"; message: string }
  | { status: "present"; request: InclusiveForkRequest };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function child(value: unknown, key: string): unknown {
  if (!isRecord(value) || !(key in value)) return undefined;
  return value[key];
}

/** SHA-256 of the assistant message's text (UTF-8), prefixed `sha256:`. */
export function sha256Fingerprint(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * Message text the client fingerprints: text blocks in order, no thinking,
 * no tool calls, no tool output.
 */
export function assistantMessageText(message: AssistantMessage): string {
  if (!Array.isArray(message.content)) return "";
  let text = "";
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

export function messageIdCandidates(messageId: string): string[] {
  const candidates = [messageId];
  const stripped = messageId.replace(SEGMENT_SUFFIX, "");
  if (stripped !== messageId && stripped.trim().length > 0) candidates.push(stripped);
  return candidates;
}

/**
 * Read `_meta.jetbrains.air.fork`. A missing object keeps the whole-session fork.
 * A present but unusable object is invalid and must not fall back.
 */
export function parseJetbrainsAirFork(meta: unknown): ParsedForkMeta {
  const jetbrains = child(meta, "jetbrains");
  if (jetbrains === undefined) return { status: "absent" };
  const air = child(jetbrains, "air");
  if (air === undefined) return { status: "absent" };
  if (!isRecord(air) || !("fork" in air)) return { status: "absent" };
  const fork = air["fork"];
  if (!isRecord(fork) || fork["version"] !== 1)
    return { status: "invalid", message: FORK_UNSUPPORTED_VERSION };

  const rawId = fork["messageId"];
  if (typeof rawId !== "string" || rawId.trim().length === 0) {
    return { status: "invalid", message: FORK_MESSAGE_ID };
  }

  let messageFingerprint: string | undefined;
  if ("messageFingerprint" in fork && fork["messageFingerprint"] !== undefined) {
    const fingerprint = fork["messageFingerprint"];
    if (typeof fingerprint !== "string" || !FINGERPRINT_PATTERN.test(fingerprint)) {
      return { status: "invalid", message: FORK_FINGERPRINT };
    }
    messageFingerprint = fingerprint;
  }

  let messageOccurrence = 1;
  if ("messageOccurrence" in fork && fork["messageOccurrence"] !== undefined) {
    const occurrence = fork["messageOccurrence"];
    if (typeof occurrence !== "number" || !Number.isSafeInteger(occurrence) || occurrence < 1) {
      return { status: "invalid", message: FORK_OCCURRENCE };
    }
    messageOccurrence = occurrence;
  }

  return {
    status: "present",
    request: {
      messageId: rawId.trim(),
      messageOccurrence,
      ...(messageFingerprint !== undefined ? { messageFingerprint } : {}),
    },
  };
}

export function forkPointNotFoundMessage(messageId: string, sessionId: string): string {
  return `Fork point message ${messageId} was not found in session ${sessionId}`;
}

function isForkableAssistant(entry: SessionEntry): entry is SessionMessageEntry {
  if (entry.type !== "message") return false;
  const message = entry.message as { role?: unknown; stopReason?: unknown };
  // Persisted assistant turns carry stopReason. A message still streaming is not
  // in the file. Subagent transcripts live in their own session files.
  return (
    message.role === "assistant" && typeof message.stopReason === "string" && message.stopReason.length > 0
  );
}

function fingerprintOf(entry: SessionMessageEntry): string {
  return sha256Fingerprint(assistantMessageText(entry.message as AssistantMessage));
}

function pickByFingerprint(
  entries: readonly SessionMessageEntry[],
  fingerprint: string,
  occurrence: number,
): SessionMessageEntry | undefined {
  const matches = entries.filter((entry) => fingerprintOf(entry) === fingerprint);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return undefined;
  return matches[occurrence - 1];
}

function timeOrdered(entries: readonly SessionEntry[]): SessionMessageEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .filter((item): item is { entry: SessionMessageEntry; index: number } => isForkableAssistant(item.entry))
    .sort((left, right) => {
      const byTime = left.entry.timestamp.localeCompare(right.entry.timestamp);
      return byTime !== 0 ? byTime : left.index - right.index;
    })
    .map((item) => item.entry);
}

function matchMessageId(
  entries: readonly SessionMessageEntry[],
  request: InclusiveForkRequest,
  idScope: readonly SessionEntry[],
): SessionMessageEntry | undefined {
  for (const candidate of messageIdCandidates(request.messageId)) {
    const byEntryId = entries.find((entry) => entry.id === candidate);
    // Live ids are `<parentEntryId>:<ordinal>`, not the assistant entry id.
    const found = byEntryId ?? entries.find((entry) => assistantAcpMessageId(entry, idScope) === candidate);
    if (found === undefined) continue;
    // A hit whose text does not match the fingerprint is a stale id, not a match.
    if (request.messageFingerprint !== undefined && fingerprintOf(found) !== request.messageFingerprint)
      continue;
    return found;
  }
  return undefined;
}

/**
 * Find the assistant entry to keep.
 *
 * Id search uses the compaction-aware visible branch, then the full entry tree
 * (a compacted message keeps its entry id). A fingerprint mismatch rejects that
 * id so a restarted counter cannot select a different message. Fingerprint
 * search uses the visible branch first, then the full tree.
 */
export function locateForkAssistant(
  visible: readonly SessionEntry[],
  allEntries: readonly SessionEntry[],
  request: InclusiveForkRequest,
): SessionMessageEntry | undefined {
  const visibleAssistants = visible.filter(isForkableAssistant);
  const visibleId = matchMessageId(visibleAssistants, request, allEntries);
  if (visibleId !== undefined) return visibleId;
  const tree = timeOrdered(allEntries);
  const treeId = matchMessageId(tree, request, allEntries);
  if (treeId !== undefined) return treeId;
  if (request.messageFingerprint === undefined) return undefined;

  const visibleHit = pickByFingerprint(
    visibleAssistants,
    request.messageFingerprint,
    request.messageOccurrence,
  );
  if (visibleHit !== undefined) return visibleHit;
  if (visibleAssistants.some((entry) => fingerprintOf(entry) === request.messageFingerprint))
    return undefined;

  return pickByFingerprint(tree, request.messageFingerprint, request.messageOccurrence);
}

/**
 * Drop tool-call blocks on the selected assistant message.
 *
 * Tool results are later entries. An inclusive cut stops on the assistant
 * message, so those results are not copied. Leaving the tool calls in place
 * would make the next model request an unfinished tool turn. Text and thinking
 * stay. Pi then sees a normal assistant message and the following user prompt
 * continues from it.
 */
export function stripTrailingToolCalls(entry: SessionMessageEntry): void {
  const message = entry.message;
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;
  if (!message.content.some((block) => block.type === "toolCall")) return;
  const kept = message.content.filter((block) => block.type !== "toolCall");
  message.content = kept.length > 0 ? kept : [{ type: "text", text: "" }];
}

/**
 * Write a new session file whose leaf is `entryId` (inclusive) and return its path.
 * The source file is not rewritten.
 */
export function branchInclusiveSession(
  sourceFile: string,
  cwd: string,
  sessionDir: string | undefined,
  entryId: string,
): string {
  const opened = SessionManager.open(sourceFile, sessionDir, cwd);
  return cutOpenedSession(opened, entryId);
}

/**
 * Locate the fork point and write the truncated session. Returns undefined when
 * the point cannot be matched. The source file is not rewritten.
 */
export function forkInclusiveSession(
  sourceFile: string,
  cwd: string,
  sessionDir: string | undefined,
  request: InclusiveForkRequest,
): string | undefined {
  const opened = SessionManager.open(sourceFile, sessionDir, cwd);
  const target = locateForkAssistant(opened.buildContextEntries(), opened.getEntries(), request);
  if (target === undefined) return undefined;
  return cutOpenedSession(opened, target.id);
}

function cutOpenedSession(opened: SessionManager, entryId: string): string {
  const entry = opened.getEntry(entryId);
  if (entry === undefined || !isForkableAssistant(entry)) {
    throw new Error(`fork entry ${entryId} is not a completed assistant message`);
  }
  stripTrailingToolCalls(entry);
  const branched = opened.createBranchedSession(entryId);
  if (branched === undefined) throw new Error("inclusive fork did not produce a session file");
  return branched;
}
