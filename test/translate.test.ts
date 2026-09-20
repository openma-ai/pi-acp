import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assistantStopReasonToAcp, SessionProjection } from "../src/acp/translate.ts";

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function projection(files: Record<string, string> = {}): SessionProjection {
  return new SessionProjection({
    cwd: "/w",
    files: { read: (path) => files[path] ?? null },
  });
}

describe("SessionProjection streaming", () => {
  it("streams text and thinking deltas with a stable message id", () => {
    const p = projection();
    p.onEvent({ type: "message_start", message: assistant() } as AgentSessionEvent);
    const partial = assistant();
    const text = p.onEvent({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial },
    } as AgentSessionEvent);
    const thought = p.onEvent({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm", partial },
    } as AgentSessionEvent);
    expect(text).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" }, messageId: "m1" },
    ]);
    expect(thought).toEqual([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" }, messageId: "m1" },
    ]);
  });

  it("surfaces streamed tool calls as pending and never downgrades in_progress", () => {
    const p = projection();
    const partial = assistant({
      content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }],
    });
    const created = p.onEvent({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
    } as AgentSessionEvent);
    expect(created).toMatchObject([
      { sessionUpdate: "tool_call", toolCallId: "t1", kind: "execute", status: "pending", title: "ls" },
    ]);
    const started = p.onEvent({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(started).toMatchObject([
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" },
    ]);
    const late = p.onEvent({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "", partial },
    } as AgentSessionEvent);
    expect(late).toEqual([]);
  });

  it("fences shell output and reports failures", () => {
    const p = projection();
    p.onEvent({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "false" },
    });
    const end = p.onEvent({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "boom\n" }] },
      isError: true,
    });
    expect(end).toMatchObject([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "```sh\nboom\n```\n" } }],
      },
    ]);
  });

  it("emits display-terminal metadata when the client advertises it", () => {
    const p = new SessionProjection({ cwd: "/w", terminalOutput: true });
    const start = p.onEvent({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(start[0]).toMatchObject({
      sessionUpdate: "tool_call",
      content: [{ type: "terminal", terminalId: "t1" }],
      _meta: { terminal_info: { terminal_id: "t1", cwd: "/w" } },
    });
    const update = p.onEvent({
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
      partialResult: { content: [{ type: "text", text: "a\n" }] },
    });
    expect(update[0]).toMatchObject({ _meta: { terminal_output: { terminal_id: "t1", data: "a\n" } } });
    const end = p.onEvent({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "a\nb\n" }] },
      isError: false,
    });
    expect(end[0]).toMatchObject({
      status: "completed",
      _meta: {
        terminal_output: { terminal_id: "t1", data: "b\n" },
        terminal_exit: { terminal_id: "t1", exit_code: 0 },
      },
    });
  });

  it("emits a structured diff for edits with a line location", () => {
    const files: Record<string, string> = { "/w/a.ts": "one\ntwo\nthree\n" };
    const p = projection(files);
    const args = { path: "a.ts", edits: [{ oldText: "two", newText: "2" }] };
    const start = p.onEvent({ type: "tool_execution_start", toolCallId: "e1", toolName: "edit", args });
    expect(start[0]).toMatchObject({
      sessionUpdate: "tool_call",
      kind: "edit",
      locations: [{ path: "/w/a.ts", line: 2 }],
    });
    files["/w/a.ts"] = "one\n2\nthree\n";
    const end = p.onEvent({
      type: "tool_execution_end",
      toolCallId: "e1",
      toolName: "edit",
      result: { content: [{ type: "text", text: "ok" }], details: { diff: "-two\n+2", firstChangedLine: 2 } },
      isError: false,
    });
    expect(end[0]).toMatchObject({
      status: "completed",
      content: [{ type: "diff", path: "/w/a.ts", oldText: "one\ntwo\nthree\n", newText: "one\n2\nthree\n" }],
      locations: [{ path: "/w/a.ts", line: 2 }],
    });
  });

  it("emits a plan from the update_plan tool", () => {
    const p = projection();
    const args = {
      entries: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "pending", priority: "high" },
      ],
    };
    p.onEvent({ type: "tool_execution_start", toolCallId: "p1", toolName: "update_plan", args });
    const end = p.onEvent({
      type: "tool_execution_end",
      toolCallId: "p1",
      toolName: "update_plan",
      result: { content: [] },
      isError: false,
    });
    expect(end[0]).toEqual({
      sessionUpdate: "plan",
      entries: [
        { content: "a", status: "in_progress", priority: "medium" },
        { content: "b", status: "pending", priority: "high" },
      ],
    });
    expect(p.plan).toHaveLength(2);
  });

  it("accumulates usage per prompt and emits usage_update with context size", () => {
    const p = projection();
    p.setContextWindow(1000);
    p.beginPrompt();
    const updates = p.onEvent({ type: "message_end", message: assistant() } as AgentSessionEvent);
    expect(updates[0]).toEqual({ sessionUpdate: "usage_update", used: 15, size: 1000 });
    expect(updates[1]).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "" },
      _meta: { pi: { event: "assistant_message" } },
    });
    expect(p.promptUsage()).toEqual({ totalTokens: 15, inputTokens: 10, outputTokens: 5 });
    p.beginPrompt();
    expect(p.promptUsage()).toBeUndefined();
  });

  it("tracks assistant errors until a later success", () => {
    const p = projection();
    p.onEvent({
      type: "message_end",
      message: assistant({ stopReason: "error", errorMessage: "rate limited" }),
    } as AgentSessionEvent);
    expect(p.promptError).toBe("rate limited");
    p.onEvent({ type: "message_end", message: assistant() } as AgentSessionEvent);
    expect(p.promptError).toBeUndefined();
  });

  it("projects compaction lifecycle", () => {
    const p = projection();
    const start = p.onEvent({ type: "compaction_start", reason: "threshold" });
    expect(start[0]).toMatchObject({ sessionUpdate: "compaction_update", status: "in_progress" });
    const end = p.onEvent({
      type: "compaction_end",
      reason: "threshold",
      result: { summary: "sum", firstKeptEntryId: "x", tokensBefore: 100 },
      aborted: false,
      willRetry: false,
    });
    expect(end[0]).toMatchObject({
      sessionUpdate: "compaction_update",
      status: "completed",
      summary: [{ type: "text", text: "sum" }],
    });
  });

  it("maps stop reasons", () => {
    expect(assistantStopReasonToAcp(assistant({ stopReason: "aborted" }))).toBe("cancelled");
    expect(assistantStopReasonToAcp(assistant({ stopReason: "length" }))).toBe("max_tokens");
    expect(assistantStopReasonToAcp(assistant())).toBe("end_turn");
    expect(assistantStopReasonToAcp(undefined)).toBe("end_turn");
  });
});
