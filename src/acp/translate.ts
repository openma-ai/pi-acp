/**
 * Pure projection of pi `AgentSessionEvent`s onto ACP `session/update` payloads.
 *
 * Owns the per-session streaming bookkeeping (open tool calls, file snapshots
 * for structured diffs, per-prompt usage accumulation, last assistant outcome)
 * so the session class only wires transport and lifecycle.
 */

import type {
  ContentBlock,
  SessionNotification,
  StopReason,
  ToolCallContent,
  ToolCallLocation,
  Usage,
} from "@agentclientprotocol/sdk";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import { piMeta } from "./meta.ts";
import { customEntryUpdates, customMessageUpdate } from "./custom-entries.ts";
import {
  absoluteToolPath,
  asRecord,
  classifyToolCall,
  diffStats,
  editOldTexts,
  fenceShellOutput,
  findUniqueLineNumber,
  isFileMutationTool,
  isShellTool,
  toolResultImages,
  toolResultText,
  type ToolCallFacts,
} from "./tool-facts.ts";

export type SessionUpdate = SessionNotification["update"];

export interface FileAccess {
  /** Read a UTF-8 file, or null when missing/unreadable. */
  read(absolutePath: string): string | null;
}

/**
 * How shell output reaches the client when pi runs the command itself:
 * `terminal_output` / `terminal_output_delta` are the Zed/Codex display-terminal
 * `_meta` extensions (same payload, different key); `none` fences the output as text.
 */
export type TerminalOutputMode = "terminal_output" | "terminal_output_delta" | "none";

export interface ProjectionOptions {
  cwd: string;
  /** Display-terminal extension the client understands. Default `none`. */
  terminalOutput?: TerminalOutputMode | boolean;
  /** Snapshot/read files for structured `diff` content on edit/write. */
  files?: FileAccess;
  /** Owning extension path for extension-registered tools (attribution on `tool_call`). */
  toolOwner?: (toolName: string) => string | undefined;
}

export interface FileChange {
  path: string;
  kind: "add" | "update";
  added: number;
  removed: number;
}

interface OpenToolCall {
  name: string;
  status: "pending" | "in_progress";
  args: unknown;
  facts: ToolCallFacts;
  snapshot?: { path: string; oldText: string | null };
  shellOutputSent: string;
  displayTerminal: boolean;
  clientTerminalId?: string;
}

interface UsageTotals {
  input: number;
  output: number;
  cachedRead: number;
  cachedWrite: number;
  thought: number;
}

interface PromptWindow {
  usage: UsageTotals;
  sawUsage: boolean;
  lastAssistant: AssistantMessage | undefined;
  /** Assistant error captured for the prompt; cleared by a later successful message. */
  error: string | undefined;
  compactionSeq: number;
  /** Files touched by edit/write during the prompt, keyed by absolute path. */
  fileChanges: Map<string, FileChange>;
}

function emptyWindow(): PromptWindow {
  return {
    usage: { input: 0, output: 0, cachedRead: 0, cachedWrite: 0, thought: 0 },
    sawUsage: false,
    lastAssistant: undefined,
    error: undefined,
    compactionSeq: 0,
    fileChanges: new Map(),
  };
}

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

export function assistantStopReasonToAcp(message: AssistantMessage | undefined): StopReason {
  switch (message?.stopReason) {
    case "aborted":
      return "cancelled";
    case "length":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

export class SessionProjection {
  private readonly cwd: string;
  private readonly terminalMode: TerminalOutputMode;
  private readonly files: FileAccess | undefined;
  private toolOwner: (toolName: string) => string | undefined;
  private readonly toolCalls = new Map<string, OpenToolCall>();
  private window: PromptWindow = emptyWindow();
  private contextWindow: number | undefined;
  private messageSeq = 0;
  private currentMessageId: string | undefined;

  constructor(options: ProjectionOptions) {
    this.cwd = options.cwd;
    const mode = options.terminalOutput;
    this.terminalMode =
      mode === true ? "terminal_output" : mode === false || mode === undefined ? "none" : mode;
    this.files = options.files;
    this.toolOwner = options.toolOwner ?? (() => undefined);
  }

  /** Replace the tool → extension lookup (after `reload`, extensions may change). */
  setToolOwner(lookup: (toolName: string) => string | undefined): void {
    this.toolOwner = lookup;
  }

  private terminalMeta(id: string, delta: string): Record<string, unknown> {
    return { [this.terminalMode]: { terminal_id: id, data: delta } };
  }

  /**
   * Bind a client-owned ACP terminal to an open shell tool call (terminal
   * delegation). Returns the update that points the tool call at the terminal.
   */
  attachClientTerminal(toolCallId: string, terminalId: string): SessionUpdate | undefined {
    const state = this.toolCalls.get(toolCallId);
    if (state === undefined) return undefined;
    state.clientTerminalId = terminalId;
    return {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: state.status,
      content: [{ type: "terminal", terminalId }],
    };
  }

  setContextWindow(size: number | undefined): void {
    this.contextWindow = size !== undefined && size > 0 ? size : undefined;
  }

  /** Reset per-prompt accumulators; call when a new `session/prompt` starts. */
  beginPrompt(): void {
    this.window = emptyWindow();
  }

  get lastAssistant(): AssistantMessage | undefined {
    return this.window.lastAssistant;
  }

  get promptError(): string | undefined {
    return this.window.error;
  }

  /** Files changed during the current prompt (edit/write with a readable result). */
  fileChanges(): FileChange[] {
    return [...this.window.fileChanges.values()];
  }

  promptUsage(): Usage | undefined {
    if (!this.window.sawUsage) return undefined;
    const { input, output, cachedRead, cachedWrite, thought } = this.window.usage;
    return {
      totalTokens: input + output + cachedRead + cachedWrite,
      inputTokens: input,
      outputTokens: output,
      ...(thought > 0 ? { thoughtTokens: thought } : {}),
      ...(cachedRead > 0 ? { cachedReadTokens: cachedRead } : {}),
      ...(cachedWrite > 0 ? { cachedWriteTokens: cachedWrite } : {}),
    };
  }

  /** Forget open tool calls (e.g. after cancel) without emitting fabricated failures. */
  clearOpenToolCalls(): void {
    this.toolCalls.clear();
  }

  onEvent(event: AgentSessionEvent): SessionUpdate[] {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          this.messageSeq += 1;
          this.currentMessageId = `m${this.messageSeq}`;
        }
        return [];
      case "message_update":
        return this.onMessageUpdate(event.assistantMessageEvent);
      case "message_end":
        return this.onMessageEnd(event.message);
      case "tool_execution_start":
        return this.onToolStart(event.toolCallId, event.toolName, event.args);
      case "tool_execution_update":
        return this.onToolUpdate(event.toolCallId, event.partialResult);
      case "tool_execution_end":
        return this.onToolEnd(event.toolCallId, event.result, event.isError);
      case "compaction_start":
        this.window.compactionSeq += 1;
        return [
          {
            sessionUpdate: "compaction_update",
            compactionId: this.compactionId(),
            status: "in_progress",
            _meta: piMeta({ reason: event.reason }),
          },
        ];
      case "compaction_end": {
        const status = event.aborted ? "cancelled" : event.result === undefined ? "failed" : "completed";
        const summary = event.result?.summary;
        return [
          {
            sessionUpdate: "compaction_update",
            compactionId: this.compactionId(),
            status,
            ...(summary !== undefined && summary.length > 0
              ? { summary: [{ type: "text", text: summary } satisfies ContentBlock] }
              : {}),
            ...(event.errorMessage !== undefined ? { error: event.errorMessage } : {}),
            _meta: piMeta({
              reason: event.reason,
              ...(event.result !== undefined ? { tokensBefore: event.result.tokensBefore } : {}),
            }),
          },
        ];
      }
      case "auto_retry_start": {
        const seconds = Math.max(1, Math.round(event.delayMs / 1000));
        return [
          {
            sessionUpdate: "session_info_update",
            _meta: piMeta({
              event: "auto_retry",
              phase: "start",
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              error: event.errorMessage,
            }),
          },
          {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `\n_Retrying (attempt ${event.attempt}/${event.maxAttempts}, waiting ${seconds}s): ${event.errorMessage}_\n`,
            },
            _meta: piMeta({ notice: "auto_retry" }),
          },
        ];
      }
      case "auto_retry_end":
        return [
          {
            sessionUpdate: "session_info_update",
            _meta: piMeta({
              event: "auto_retry",
              phase: "end",
              success: event.success,
              attempt: event.attempt,
              ...(event.finalError !== undefined ? { error: event.finalError } : {}),
            }),
          },
        ];
      case "queue_update":
        return [
          {
            sessionUpdate: "session_info_update",
            _meta: piMeta({
              event: "queue",
              steering: [...event.steering],
              followUp: [...event.followUp],
            }),
          },
        ];
      case "entry_appended":
        return customEntryUpdates(event.entry);
      case "session_info_changed":
        return [
          {
            sessionUpdate: "session_info_update",
            title: event.name ?? null,
            updatedAt: new Date().toISOString(),
          },
        ];
      default:
        return [];
    }
  }

  // ------------------------------------------------------------------ //
  // Assistant streaming                                                 //
  // ------------------------------------------------------------------ //

  private compactionId(): string {
    return `compaction-${this.messageSeq}-${this.window.compactionSeq}`;
  }

  private chunk(kind: "agent_message_chunk" | "agent_thought_chunk", text: string): SessionUpdate {
    return {
      sessionUpdate: kind,
      content: { type: "text", text },
      ...(this.currentMessageId !== undefined ? { messageId: this.currentMessageId } : {}),
    };
  }

  private onMessageUpdate(event: AssistantMessageEvent): SessionUpdate[] {
    switch (event.type) {
      case "text_delta":
        return event.delta.length > 0 ? [this.chunk("agent_message_chunk", event.delta)] : [];
      case "thinking_delta":
        return event.delta.length > 0 ? [this.chunk("agent_thought_chunk", event.delta)] : [];
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end": {
        const block = event.partial.content[event.contentIndex];
        if (block === undefined || block.type !== "toolCall") return [];
        return this.onToolCallStreamed(block, event.type === "toolcall_end");
      }
      default:
        return [];
    }
  }

  private onToolCallStreamed(toolCall: ToolCall, complete: boolean): SessionUpdate[] {
    const id = toolCall.id;
    if (!id) return [];
    const args = toolCall.arguments ?? {};
    const facts = classifyToolCall(toolCall.name, args, this.cwd);
    const existing = this.toolCalls.get(id);
    if (existing === undefined) {
      const state: OpenToolCall = {
        name: toolCall.name,
        status: "pending",
        args,
        facts,
        shellOutputSent: "",
        displayTerminal: false,
      };
      this.toolCalls.set(id, state);
      return [this.toolCallCreated(id, state)];
    }
    // Never downgrade in_progress back to pending; keep args fresh while streaming.
    existing.args = args;
    existing.facts = facts;
    if (!complete && existing.status === "in_progress") return [];
    return [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        title: facts.title,
        kind: facts.kind,
        status: existing.status,
        rawInput: args,
        ...(facts.locations.length > 0 ? { locations: facts.locations } : {}),
      },
    ];
  }

  private onMessageEnd(message: unknown): SessionUpdate[] {
    const record = asRecord(message);
    if (record.role === "custom" && typeof record["customType"] === "string") {
      // Extension `sendMessage` delivered during a turn (steer/followUp/queued).
      return [
        customMessageUpdate({
          customType: record["customType"],
          content: record["content"],
          display: record["display"] === true,
          details: record["details"],
        }),
      ];
    }
    if (record.role !== "assistant") return [];
    const assistant = message as AssistantMessage;
    this.window.lastAssistant = assistant;
    if (assistant.stopReason === "error") {
      const text = typeof assistant.errorMessage === "string" ? assistant.errorMessage.trim() : "";
      this.window.error = text.length > 0 ? text : "The model request failed.";
    } else if (assistant.stopReason !== "aborted") {
      this.window.error = undefined;
    }

    const updates: SessionUpdate[] = [];
    const usage = assistant.usage;
    if (usage !== undefined) {
      const input = num(usage.input);
      const output = num(usage.output);
      const cachedRead = num(usage.cacheRead);
      const cachedWrite = num(usage.cacheWrite);
      const thought = num(usage.reasoning);
      if (input + output + cachedRead + cachedWrite > 0) {
        this.window.usage.input += input;
        this.window.usage.output += output;
        this.window.usage.cachedRead += cachedRead;
        this.window.usage.cachedWrite += cachedWrite;
        this.window.usage.thought += thought;
        this.window.sawUsage = true;
        const used = input + cachedRead + cachedWrite + output;
        if (this.contextWindow !== undefined && used > 0) {
          const total = num(usage.cost?.total);
          updates.push({
            sessionUpdate: "usage_update",
            used,
            size: this.contextWindow,
            ...(total > 0 ? { cost: { amount: total, currency: "USD" } } : {}),
          });
        }
      }
    }
    // Metadata-only message boundary: lets clients close the current message id.
    updates.push({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "" },
      ...(this.currentMessageId !== undefined ? { messageId: this.currentMessageId } : {}),
      _meta: piMeta({
        event: "assistant_message",
        stopReason: assistant.stopReason,
        model: `${assistant.provider}/${assistant.model}`,
      }),
    });
    return updates;
  }

  // ------------------------------------------------------------------ //
  // Tool execution                                                      //
  // ------------------------------------------------------------------ //

  private toolCallCreated(id: string, state: OpenToolCall): SessionUpdate {
    const terminal = this.terminalContent(id, state);
    const owner = this.toolOwner(state.name);
    const meta = {
      ...(terminal?._meta ?? {}),
      ...(owner !== undefined ? piMeta({ extension: owner }) : {}),
    };
    return {
      sessionUpdate: "tool_call",
      toolCallId: id,
      title: state.facts.title,
      name: state.name,
      kind: state.facts.kind,
      status: state.status,
      rawInput: state.args,
      ...(state.facts.locations.length > 0 ? { locations: state.facts.locations } : {}),
      ...(terminal !== undefined ? { content: terminal.content } : {}),
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    };
  }

  /** Terminal presentation for shell tools: client terminal (delegated) or display terminal (`_meta`). */
  private terminalContent(
    id: string,
    state: OpenToolCall,
  ): { content: ToolCallContent[]; _meta?: Record<string, unknown> } | undefined {
    if (!isShellTool(state.name)) return undefined;
    if (state.clientTerminalId !== undefined) {
      return { content: [{ type: "terminal", terminalId: state.clientTerminalId }] };
    }
    if (this.terminalMode !== "none" && !state.displayTerminal) {
      state.displayTerminal = true;
      return {
        content: [{ type: "terminal", terminalId: id }],
        _meta: { terminal_info: { terminal_id: id, cwd: this.cwd } },
      };
    }
    return undefined;
  }

  private onToolStart(id: string, name: string, args: unknown): SessionUpdate[] {
    let line: number | undefined;
    let snapshot: OpenToolCall["snapshot"];
    if (isFileMutationTool(name) && this.files !== undefined) {
      const abs = absoluteToolPath(args, this.cwd);
      if (abs !== undefined) {
        const oldText = this.files.read(abs);
        snapshot = { path: abs, oldText };
        if (name === "edit" && oldText !== null) {
          for (const needle of editOldTexts(args)) {
            line = findUniqueLineNumber(oldText, needle);
            if (line !== undefined) break;
          }
        }
      }
    }
    const facts = classifyToolCall(name, args, this.cwd, line);
    const existing = this.toolCalls.get(id);
    if (existing === undefined) {
      const state: OpenToolCall = {
        name,
        status: "in_progress",
        args,
        facts,
        snapshot,
        shellOutputSent: "",
        displayTerminal: false,
      };
      this.toolCalls.set(id, state);
      return [this.toolCallCreated(id, state)];
    }
    existing.status = "in_progress";
    existing.args = args;
    existing.facts = facts;
    existing.snapshot = snapshot;
    const terminal =
      existing.displayTerminal || existing.clientTerminalId !== undefined
        ? undefined
        : this.terminalContent(id, existing);
    return [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        title: facts.title,
        kind: facts.kind,
        status: "in_progress",
        rawInput: args,
        ...(facts.locations.length > 0 ? { locations: facts.locations } : {}),
        ...(terminal ?? {}),
      },
    ];
  }

  private onToolUpdate(id: string, partial: unknown): SessionUpdate[] {
    const state = this.toolCalls.get(id);
    if (state === undefined) return [];
    if (isShellTool(state.name)) {
      if (state.clientTerminalId !== undefined) return []; // the client streams its own terminal
      const text = toolResultText(partial);
      const delta = text.startsWith(state.shellOutputSent) ? text.slice(state.shellOutputSent.length) : text;
      state.shellOutputSent = text;
      if (state.displayTerminal) {
        if (delta.length === 0) return [];
        return [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: id,
            status: "in_progress",
            _meta: this.terminalMeta(id, delta),
          },
        ];
      }
      if (text.length === 0) return [];
      return [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: "in_progress",
          content: [{ type: "content", content: { type: "text", text: fenceShellOutput(text) } }],
        },
      ];
    }
    if (isFileMutationTool(state.name)) return [];
    const text = toolResultText(partial);
    if (text.length === 0) return [];
    return [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text } }],
      },
    ];
  }

  private onToolEnd(id: string, result: unknown, isError: boolean): SessionUpdate[] {
    const state = this.toolCalls.get(id);
    this.toolCalls.delete(id);
    const name = state?.name ?? "tool";
    const status = isError ? "failed" : "completed";
    const text = toolResultText(result);
    const details = asRecord(asRecord(result)["details"]);
    const updates: SessionUpdate[] = [];

    if (state === undefined) {
      updates.push({
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status,
        ...(text.length > 0 ? { content: [{ type: "content", content: { type: "text", text } }] } : {}),
        rawOutput: result,
      });
      return updates;
    }

    if (isShellTool(name)) {
      const exitCode = isError ? 1 : 0;
      if (state.clientTerminalId !== undefined) {
        updates.push({
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status,
          rawOutput: result,
        });
        return updates;
      }
      if (state.displayTerminal) {
        const delta = text.startsWith(state.shellOutputSent)
          ? text.slice(state.shellOutputSent.length)
          : text;
        updates.push({
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status,
          rawOutput: result,
          _meta: {
            ...(delta.length > 0 ? this.terminalMeta(id, delta) : {}),
            terminal_exit: { terminal_id: id, exit_code: exitCode, signal: null },
          },
        });
        return updates;
      }
      updates.push({
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status,
        ...(text.length > 0
          ? { content: [{ type: "content", content: { type: "text", text: fenceShellOutput(text) } }] }
          : {}),
        rawOutput: result,
      });
      return updates;
    }

    const content: ToolCallContent[] = [];
    let locations: ToolCallLocation[] | undefined;
    if (isFileMutationTool(name) && !isError && state.snapshot !== undefined && this.files !== undefined) {
      const newText = this.files.read(state.snapshot.path);
      if (newText !== null && (state.snapshot.oldText === null || newText !== state.snapshot.oldText)) {
        const stats = diffStats(state.snapshot.oldText, newText);
        const kind = state.snapshot.oldText === null ? "add" : "update";
        content.push({
          type: "diff",
          path: state.snapshot.path,
          ...(state.snapshot.oldText !== null ? { oldText: state.snapshot.oldText } : {}),
          newText,
          _meta: piMeta({ fileChange: kind, diffStats: stats }),
        });
        const previous = this.window.fileChanges.get(state.snapshot.path);
        this.window.fileChanges.set(state.snapshot.path, {
          path: state.snapshot.path,
          kind: previous?.kind === "add" ? "add" : kind,
          added: (previous?.added ?? 0) + stats.added,
          removed: (previous?.removed ?? 0) + stats.removed,
        });
      }
      const firstChangedLine = details["firstChangedLine"];
      if (typeof firstChangedLine === "number") {
        locations = [{ path: state.snapshot.path, line: firstChangedLine }];
      }
    }
    if (content.length === 0) {
      const diffText = typeof details["diff"] === "string" ? details["diff"] : undefined;
      const shown =
        isFileMutationTool(name) && diffText !== undefined && diffText.trim().length > 0 ? diffText : text;
      if (shown.length > 0) content.push({ type: "content", content: { type: "text", text: shown } });
    }
    for (const image of toolResultImages(result)) {
      content.push({
        type: "content",
        content: { type: "image", data: image.data, mimeType: image.mimeType },
      });
    }
    updates.push({
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      status,
      ...(content.length > 0 ? { content } : {}),
      ...(locations !== undefined ? { locations } : {}),
      rawOutput: result,
    });
    return updates;
  }
}
