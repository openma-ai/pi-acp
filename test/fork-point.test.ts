import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextEntries, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { buildReplay } from "../src/acp/history.ts";
import {
  ACP_INCLUSIVE_FORK_CAPABILITY,
  acpInclusiveForkCapabilityMeta,
  mergeCapabilityMeta,
} from "../src/acp/fork-capability.ts";
import {
  assistantMessageText,
  branchInclusiveSession,
  FORK_FINGERPRINT,
  FORK_MESSAGE_ID,
  FORK_OCCURRENCE,
  FORK_UNSUPPORTED_VERSION,
  forkInclusiveSession,
  locateForkAssistant,
  parseJetbrainsAirFork,
  sha256Fingerprint,
  type InclusiveForkRequest,
} from "../src/acp/fork-point.ts";
import { assistantAcpMessageId, nextAssistantMessageId } from "../src/acp/message-id.ts";
import { SessionProjection } from "../src/acp/translate.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(text: string, extra: AssistantMessage["content"] = []): AssistantMessage {
  return {
    role: "assistant",
    content: text.length > 0 ? [{ type: "text", text }, ...extra] : extra,
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage,
    stopReason: extra.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 0,
  };
}

function entry(id: string, parentId: string | null, message: unknown, timestamp: string): SessionEntry {
  return { type: "message", id, parentId, timestamp, message } as SessionEntry;
}

function request(overrides: Partial<InclusiveForkRequest> & { messageId: string }): InclusiveForkRequest {
  return { messageOccurrence: 1, ...overrides };
}

describe("parseJetbrainsAirFork", () => {
  it("ignores meta that does not carry the fork object", () => {
    expect(parseJetbrainsAirFork(undefined)).toEqual({ status: "absent" });
    expect(parseJetbrainsAirFork(null)).toEqual({ status: "absent" });
    expect(parseJetbrainsAirFork({ pi: { restoreAdditionalDirectories: true } })).toEqual({
      status: "absent",
    });
    expect(parseJetbrainsAirFork({ jetbrains: { air: {} } })).toEqual({ status: "absent" });
    expect(parseJetbrainsAirFork({ jetbrains: "nope" })).toEqual({ status: "absent" });
  });

  it("rejects a present but unusable fork object", () => {
    expect(parseJetbrainsAirFork({ jetbrains: { air: { fork: null } } })).toEqual({
      status: "invalid",
      message: FORK_UNSUPPORTED_VERSION,
    });
    expect(parseJetbrainsAirFork({ jetbrains: { air: { fork: { version: 2, messageId: "a" } } } })).toEqual({
      status: "invalid",
      message: FORK_UNSUPPORTED_VERSION,
    });
    expect(parseJetbrainsAirFork({ jetbrains: { air: { fork: { version: "1", messageId: "a" } } } })).toEqual(
      {
        status: "invalid",
        message: FORK_UNSUPPORTED_VERSION,
      },
    );
    expect(parseJetbrainsAirFork({ jetbrains: { air: { fork: { version: 1, messageId: "  " } } } })).toEqual({
      status: "invalid",
      message: FORK_MESSAGE_ID,
    });
    expect(parseJetbrainsAirFork({ jetbrains: { air: { fork: { version: 1, messageId: 2 } } } })).toEqual({
      status: "invalid",
      message: FORK_MESSAGE_ID,
    });
    expect(
      parseJetbrainsAirFork({
        jetbrains: { air: { fork: { version: 1, messageId: "a", messageFingerprint: "sha256:ABCD" } } },
      }),
    ).toEqual({ status: "invalid", message: FORK_FINGERPRINT });
    expect(
      parseJetbrainsAirFork({
        jetbrains: { air: { fork: { version: 1, messageId: "a", messageOccurrence: 0 } } },
      }),
    ).toEqual({ status: "invalid", message: FORK_OCCURRENCE });
    expect(
      parseJetbrainsAirFork({
        jetbrains: { air: { fork: { version: 1, messageId: "a", messageOccurrence: 1.5 } } },
      }),
    ).toEqual({ status: "invalid", message: FORK_OCCURRENCE });
  });

  it("accepts version 1 and trims the message id", () => {
    const fingerprint = sha256Fingerprint("hi");
    expect(
      parseJetbrainsAirFork({
        jetbrains: { air: { fork: { version: 1, messageId: "  ab  ", messageFingerprint: fingerprint } } },
      }),
    ).toEqual({
      status: "present",
      request: { messageId: "ab", messageFingerprint: fingerprint, messageOccurrence: 1 },
    });
  });
});

describe("locateForkAssistant", () => {
  const same = sha256Fingerprint("SAME");
  const third = sha256Fingerprint("THIRD");
  const entries: SessionEntry[] = [
    entry("u1", null, { role: "user", content: "q1", timestamp: 0 }, "2026-01-01T00:00:01.000Z"),
    entry("a1", "u1", assistant("SAME"), "2026-01-01T00:00:02.000Z"),
    entry("u2", "a1", { role: "user", content: "q2", timestamp: 0 }, "2026-01-01T00:00:03.000Z"),
    entry("a2", "u2", assistant("SAME"), "2026-01-01T00:00:04.000Z"),
    entry("u3", "a2", { role: "user", content: "q3", timestamp: 0 }, "2026-01-01T00:00:05.000Z"),
    entry("a3", "u3", assistant("THIRD"), "2026-01-01T00:00:06.000Z"),
  ];

  it("matches an entry id, a derived parent id, and a :segment: suffix", () => {
    expect(locateForkAssistant(entries, entries, request({ messageId: "a2" }))?.id).toBe("a2");
    expect(locateForkAssistant(entries, entries, request({ messageId: "a2:segment:4" }))?.id).toBe("a2");
    expect(assistantAcpMessageId(entries[3] as never, entries)).toBe("u2:1");
    expect(locateForkAssistant(entries, entries, request({ messageId: "u2:1" }))?.id).toBe("a2");
    expect(locateForkAssistant(entries, entries, request({ messageId: "u2:1:segment:2" }))?.id).toBe("a2");
    expect(nextAssistantMessageId("u2", entries.slice(0, 3))).toBe("u2:1");
  });

  it("uses a unique fingerprint, then occurrence when several match", () => {
    expect(
      locateForkAssistant(entries, entries, request({ messageId: "missing", messageFingerprint: third }))?.id,
    ).toBe("a3");
    expect(
      locateForkAssistant(
        entries,
        entries,
        request({ messageId: "m2", messageFingerprint: same, messageOccurrence: 2 }),
      )?.id,
    ).toBe("a2");
    expect(
      locateForkAssistant(
        entries,
        entries,
        request({ messageId: "m2", messageFingerprint: same, messageOccurrence: 9 }),
      ),
    ).toBeUndefined();
  });

  it("drops an id hit whose fingerprint belongs to a different message", () => {
    expect(
      locateForkAssistant(entries, entries, request({ messageId: "a1", messageFingerprint: third }))?.id,
    ).toBe("a3");
  });

  it("returns undefined when nothing matches", () => {
    expect(locateForkAssistant(entries, entries, request({ messageId: "nope" }))).toBeUndefined();
    expect(
      locateForkAssistant(
        entries,
        entries,
        request({ messageId: "nope", messageFingerprint: sha256Fingerprint("nope") }),
      ),
    ).toBeUndefined();
  });

  it("finds a compacted message in the full tree", () => {
    const hidden = entry("old", null, assistant("HIDDEN"), "2026-01-01T00:00:01.000Z");
    const compaction = {
      type: "compaction",
      id: "comp",
      parentId: "old",
      timestamp: "2026-01-01T00:00:02.000Z",
      summary: "sum",
      firstKeptEntryId: "missing",
      tokensBefore: 10,
    } as SessionEntry;
    const kept = entry("new", "comp", assistant("VISIBLE"), "2026-01-01T00:00:03.000Z");
    const all = [hidden, compaction, kept];
    const visible = buildContextEntries(all, "new");
    expect(visible.map((item) => item.id)).toEqual(["comp", "new"]);
    expect(
      locateForkAssistant(
        visible,
        all,
        request({ messageId: "old", messageFingerprint: sha256Fingerprint("HIDDEN") }),
      )?.id,
    ).toBe("old");
    expect(
      locateForkAssistant(
        visible,
        all,
        request({ messageId: "m9", messageFingerprint: sha256Fingerprint("HIDDEN") }),
      )?.id,
    ).toBe("old");
    expect(locateForkAssistant(visible, all, request({ messageId: "old" }))?.id).toBe("old");
    expect(locateForkAssistant(visible, all, request({ messageId: "no-such" }))).toBeUndefined();
  });
});

describe("sha256Fingerprint", () => {
  it("hashes utf-8 text and ignores thinking", () => {
    const message = assistant("café");
    message.content = [
      { type: "thinking", thinking: "secret" },
      { type: "text", text: "café" },
    ];
    const text = assistantMessageText(message);
    expect(text).toBe("café");
    expect(sha256Fingerprint(text)).toBe(`sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`);
    expect(sha256Fingerprint("")).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("stable message ids", () => {
  it("streams live deltas and replay under the parent ordinal id", () => {
    const user = entry(
      "user-1",
      null,
      { role: "user", content: "q", timestamp: 0 },
      "2026-01-01T00:00:01.000Z",
    );
    const assistantEntry = entry("asst-1", "user-1", assistant("hello"), "2026-01-01T00:00:02.000Z");
    const replay = buildReplay([user, assistantEntry], "/w");
    const replayIds = replay.updates
      .map((update) => ("messageId" in update ? update.messageId : undefined))
      .filter((value) => value !== undefined);
    expect(replayIds.length).toBeGreaterThan(0);
    expect(replayIds.every((value) => value === "user-1:1")).toBe(true);

    const projection = new SessionProjection({ cwd: "/w" });
    const message = assistant("hello");
    projection.noteAssistantMessageId(nextAssistantMessageId("user-1", [user]));
    expect(projection.onEvent({ type: "message_start", message } as AgentSessionEvent)).toEqual([]);
    const first = projection.onEvent({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel", partial: message },
    } as AgentSessionEvent);
    const second = projection.onEvent({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo", partial: message },
    } as AgentSessionEvent);
    expect(first).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hel" }, messageId: "user-1:1" },
    ]);
    expect(second).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" }, messageId: "user-1:1" },
    ]);
  });
});

describe("capability meta", () => {
  it("deep-merges the inclusive fork object beside pi and authStatus", () => {
    expect(ACP_INCLUSIVE_FORK_CAPABILITY).toEqual({ version: 1, inclusive: true });
    const merged = mergeCapabilityMeta(
      { pi: { version: "0.1.5", delegation: { terminal: false } }, authStatus: {} },
      acpInclusiveForkCapabilityMeta(),
    );
    expect(merged).toEqual({
      pi: { version: "0.1.5", delegation: { terminal: false } },
      authStatus: {},
      jetbrains: { air: { fork: { version: 1, inclusive: true } } },
    });
  });
});

describe("branchInclusiveSession", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function session(): { cwd: string; dir: string; manager: SessionManager } {
    root = mkdtempSync(join(tmpdir(), "pi-acp-fork-"));
    const cwd = join(root, "work");
    const dir = join(root, "sessions");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(dir, { recursive: true });
    const manager = SessionManager.create(cwd, dir);
    return { cwd, dir, manager };
  }

  function user(text: string): UserMessage {
    return { role: "user", content: text, timestamp: 0 };
  }

  function toolResult(): ToolResultMessage {
    return {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: "listed\n" }],
      isError: false,
      timestamp: 0,
    };
  }

  it("cuts through the selected assistant and leaves the source file untouched", () => {
    const { cwd, dir, manager } = session();
    manager.appendMessage(user("q1"));
    const first = manager.appendMessage(assistant("SAME"));
    manager.appendMessage(user("q2"));
    const second = manager.appendMessage(assistant("SAME"));
    manager.appendMessage(user("q3"));
    manager.appendMessage(assistant("THIRD"));
    const source = manager.getSessionFile();
    expect(source).toBeDefined();
    const before = readFileSync(source!, "utf8");
    const branched = forkInclusiveSession(source!, cwd, dir, {
      messageId: "m2",
      messageFingerprint: sha256Fingerprint("SAME"),
      messageOccurrence: 2,
    });
    expect(branched).toBeDefined();
    expect(readFileSync(source!, "utf8")).toBe(before);
    const opened = SessionManager.open(branched!, dir, cwd);
    const texts = opened
      .buildContextEntries()
      .flatMap((item) =>
        item.type === "message" && item.message.role === "assistant"
          ? [assistantMessageText(item.message as AssistantMessage)]
          : [],
      );
    expect(texts).toEqual(["SAME", "SAME"]);
    expect(opened.getLeafId()).toBe(second);
    expect(first).not.toBe(second);
  });

  it("drops tool calls on the selected message and does not copy their results", () => {
    const { cwd, dir, manager } = session();
    manager.appendMessage(user("look"));
    const withTool = manager.appendMessage(
      assistant("reading", [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }]),
    );
    manager.appendMessage(toolResult());
    manager.appendMessage(assistant("done"));
    const source = manager.getSessionFile()!;
    const before = readFileSync(source, "utf8");
    const branched = branchInclusiveSession(source, cwd, dir, withTool);
    expect(readFileSync(source, "utf8")).toBe(before);
    expect(before).toContain("toolCall");
    const opened = SessionManager.open(branched, dir, cwd);
    const assistants = opened
      .getEntries()
      .flatMap((item) => (item.type === "message" && item.message.role === "assistant" ? [item] : []));
    expect(assistants).toHaveLength(1);
    const content = (assistants[0]!.message as AssistantMessage).content;
    expect(content.some((block) => block.type === "toolCall")).toBe(false);
    expect(assistantMessageText(assistants[0]!.message as AssistantMessage)).toBe("reading");
    expect(
      opened.getEntries().some((item) => item.type === "message" && item.message.role === "toolResult"),
    ).toBe(false);
  });
});
