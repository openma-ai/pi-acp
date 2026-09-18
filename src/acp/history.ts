/**
 * `session/load` history replay: pi session entries → ACP updates (pure).
 *
 * Walks the active branch (compaction-aware) and projects each entry through
 * the same vocabulary the live projection uses. Only the final plan snapshot
 * and the final usage are replayed; intermediate states are noise after the fact.
 */

import type { ContentBlock, PlanEntry, ToolCallContent, Usage } from "@agentclientprotocol/sdk";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { piMeta } from "./meta.ts";
import { planEntriesFromArgs, PLAN_TOOL_NAME } from "./plan-tool.ts";
import {
  asRecord,
  classifyToolCall,
  fenceShellOutput,
  isFileMutationTool,
  isShellTool,
  toolResultImages,
  toolResultText,
} from "./tool-facts.ts";
import type { SessionUpdate } from "./translate.ts";

export interface ReplayResult {
  updates: SessionUpdate[];
  title: string | undefined;
  usage: Usage | undefined;
  plan: PlanEntry[] | undefined;
}

function userContentToBlocks(content: UserMessage["content"]): ContentBlock[] {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text.length > 0) blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  return blocks;
}

export function buildReplay(entries: readonly SessionEntry[], cwd: string): ReplayResult {
  const updates: SessionUpdate[] = [];
  let title: string | undefined;
  let plan: PlanEntry[] | undefined;
  let messageSeq = 0;
  const usage = { input: 0, output: 0, cachedRead: 0, cachedWrite: 0, thought: 0, saw: false };
  const openToolCalls = new Map<string, { name: string; args: unknown }>();

  for (const entry of entries) {
    switch (entry.type) {
      case "session_info":
        if (typeof entry.name === "string" && entry.name.trim().length > 0) title = entry.name.trim();
        break;
      case "message": {
        const message = entry.message as { role?: string };
        if (message.role === "user") {
          for (const block of userContentToBlocks((entry.message as UserMessage).content)) {
            updates.push({ sessionUpdate: "user_message_chunk", content: block });
          }
        } else if (message.role === "assistant") {
          const assistant = entry.message as AssistantMessage;
          messageSeq += 1;
          const messageId = `h${messageSeq}`;
          for (const block of assistant.content) {
            if (block.type === "thinking" && block.thinking.length > 0) {
              updates.push({
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: block.thinking },
                messageId,
              });
            } else if (block.type === "text" && block.text.length > 0) {
              updates.push({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: block.text },
                messageId,
              });
            } else if (block.type === "toolCall") {
              const facts = classifyToolCall(block.name, block.arguments, cwd);
              openToolCalls.set(block.id, { name: block.name, args: block.arguments });
              updates.push({
                sessionUpdate: "tool_call",
                toolCallId: block.id,
                title: facts.title,
                name: block.name,
                kind: facts.kind,
                status: "pending",
                rawInput: block.arguments,
                ...(facts.locations.length > 0 ? { locations: facts.locations } : {}),
              });
            }
          }
          if (assistant.usage !== undefined) {
            const u = assistant.usage;
            usage.input += u.input ?? 0;
            usage.output += u.output ?? 0;
            usage.cachedRead += u.cacheRead ?? 0;
            usage.cachedWrite += u.cacheWrite ?? 0;
            usage.thought += u.reasoning ?? 0;
            usage.saw = true;
          }
          if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
            updates.push({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "" },
              messageId,
              _meta: piMeta({
                event: "assistant_message",
                stopReason: assistant.stopReason,
                ...(assistant.errorMessage !== undefined ? { error: assistant.errorMessage } : {}),
              }),
            });
          }
        } else if (message.role === "toolResult") {
          const result = entry.message as ToolResultMessage;
          const open = openToolCalls.get(result.toolCallId);
          openToolCalls.delete(result.toolCallId);
          const name = result.toolName ?? open?.name ?? "tool";
          const text = toolResultText(result);
          const details = asRecord(result.details);
          const status = result.isError ? "failed" : "completed";
          const content: ToolCallContent[] = [];
          if (name === PLAN_TOOL_NAME) {
            const entries =
              planEntriesFromArgs(open?.args) ?? (details["entries"] as PlanEntry[] | undefined);
            if (!result.isError && entries !== undefined) plan = entries;
          }
          if (isShellTool(name)) {
            if (text.length > 0)
              content.push({ type: "content", content: { type: "text", text: fenceShellOutput(text) } });
          } else {
            const diffText = typeof details["diff"] === "string" ? details["diff"] : undefined;
            const shown =
              isFileMutationTool(name) && diffText !== undefined && diffText.trim().length > 0
                ? diffText
                : text;
            if (shown.length > 0) content.push({ type: "content", content: { type: "text", text: shown } });
          }
          for (const image of toolResultImages(result)) {
            content.push({
              type: "content",
              content: { type: "image", data: image.data, mimeType: image.mimeType },
            });
          }
          if (open === undefined) {
            const facts = classifyToolCall(name, {}, cwd);
            updates.push({
              sessionUpdate: "tool_call",
              toolCallId: result.toolCallId,
              title: facts.title,
              name,
              kind: facts.kind,
              status,
            });
          }
          updates.push({
            sessionUpdate: "tool_call_update",
            toolCallId: result.toolCallId,
            status,
            ...(content.length > 0 ? { content } : {}),
            rawOutput: { content: result.content, details: result.details, isError: result.isError },
          });
        } else if (message.role === "bashExecution") {
          const bash = entry.message as {
            command: string;
            output: string;
            exitCode: number | undefined;
            cancelled: boolean;
          };
          const toolCallId = `bash-${entry.id}`;
          updates.push({
            sessionUpdate: "tool_call",
            toolCallId,
            title: bash.command.split("\n", 1)[0] ?? "bash",
            name: "bash",
            kind: "execute",
            status: "completed",
            rawInput: { command: bash.command },
          });
          updates.push({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status:
              bash.cancelled || (bash.exitCode !== undefined && bash.exitCode !== 0) ? "failed" : "completed",
            ...(bash.output.length > 0
              ? {
                  content: [
                    { type: "content", content: { type: "text", text: fenceShellOutput(bash.output) } },
                  ],
                }
              : {}),
            rawOutput: { output: bash.output, exitCode: bash.exitCode, cancelled: bash.cancelled },
          });
        } else if (message.role === "custom") {
          const custom = entry.message as { customType: string; display: boolean; content: unknown };
          const preview =
            typeof custom.content === "string" ? custom.content : toolResultText({ content: custom.content });
          updates.push({
            sessionUpdate: "session_info_update",
            _meta: piMeta({
              event: "custom_message",
              customType: custom.customType,
              display: custom.display,
              preview: Array.from(preview).slice(0, 160).join(""),
            }),
          });
        }
        break;
      }
      case "compaction":
        updates.push({
          sessionUpdate: "compaction_update",
          compactionId: `compaction-${entry.id}`,
          status: "completed",
          summary: [{ type: "text", text: entry.summary }],
          _meta: piMeta({ tokensBefore: entry.tokensBefore }),
        });
        break;
      case "branch_summary":
        updates.push({
          sessionUpdate: "session_info_update",
          _meta: piMeta({ event: "branch_summary", fromId: entry.fromId, summary: entry.summary }),
        });
        break;
      case "custom_message": {
        const preview =
          typeof entry.content === "string" ? entry.content : toolResultText({ content: entry.content });
        updates.push({
          sessionUpdate: "session_info_update",
          _meta: piMeta({
            event: "custom_message",
            customType: entry.customType,
            display: entry.display,
            preview: Array.from(preview).slice(0, 160).join(""),
          }),
        });
        break;
      }
      default:
        break;
    }
  }

  if (plan !== undefined) updates.push({ sessionUpdate: "plan", entries: plan });
  const finalUsage: Usage | undefined = usage.saw
    ? {
        totalTokens: usage.input + usage.output + usage.cachedRead + usage.cachedWrite,
        inputTokens: usage.input,
        outputTokens: usage.output,
        ...(usage.thought > 0 ? { thoughtTokens: usage.thought } : {}),
        ...(usage.cachedRead > 0 ? { cachedReadTokens: usage.cachedRead } : {}),
        ...(usage.cachedWrite > 0 ? { cachedWriteTokens: usage.cachedWrite } : {}),
      }
    : undefined;
  return { updates, title, usage: finalUsage, plan };
}
