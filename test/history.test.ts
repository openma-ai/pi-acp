import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildReplay } from "../src/acp/history.ts";

const usage = {
  input: 3,
  output: 2,
  cacheRead: 1,
  cacheWrite: 0,
  totalTokens: 6,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entry(id: string, message: unknown): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message,
  } as SessionEntry;
}

describe("buildReplay", () => {
  it("replays user, assistant, and tool history in order", () => {
    const entries: SessionEntry[] = [
      entry("1", { role: "user", content: "hi", timestamp: 0 }),
      entry("2", {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "t" },
          { type: "text", text: "run" },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
        ],
        api: "faux",
        provider: "faux",
        model: "m",
        usage,
        stopReason: "toolUse",
        timestamp: 0,
      }),
      entry("3", {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: "a\n" }],
        isError: false,
        timestamp: 0,
      }),
      { type: "session_info", id: "5", parentId: "3", timestamp: "", name: "My session" } as SessionEntry,
    ];
    const replay = buildReplay(entries, "/w");
    const kinds = replay.updates.map((u) => u.sessionUpdate);
    expect(kinds).toEqual([
      "user_message_chunk",
      "agent_thought_chunk",
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
    ]);
    expect(replay.updates[4]).toMatchObject({
      toolCallId: "c1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "```sh\na\n```\n" } }],
    });
    expect(replay.title).toBe("My session");
    expect(replay.usage).toEqual({ totalTokens: 6, inputTokens: 3, outputTokens: 2, cachedReadTokens: 1 });
  });

  it("replays compaction entries and bash executions", () => {
    const entries: SessionEntry[] = [
      {
        type: "compaction",
        id: "c",
        parentId: null,
        timestamp: "",
        summary: "S",
        firstKeptEntryId: "x",
        tokensBefore: 42,
      } as SessionEntry,
      entry("b", {
        role: "bashExecution",
        command: "echo 1",
        output: "1\n",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 0,
      }),
    ];
    const replay = buildReplay(entries, "/w");
    expect(replay.updates[0]).toMatchObject({
      sessionUpdate: "compaction_update",
      status: "completed",
      summary: [{ type: "text", text: "S" }],
    });
    expect(replay.updates[1]).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "bash-b",
      kind: "execute",
    });
    expect(replay.updates[2]).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed" });
  });
});
