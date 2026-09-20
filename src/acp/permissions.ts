/**
 * Permission modes (ACP session modes) and the tool-call gate that enforces them.
 *
 * pi executes tools locally without prompts. This adapter adds three modes:
 *
 * - `read-only`      — mutating tools are blocked before execution
 * - `ask`            — mutating tools require an ACP `session/request_permission`
 * - `full-access`    — no prompts (pi's native behavior)
 *
 * The gate is an inline pi extension (`tool_call` handler) bound per session.
 */

import type { PermissionOption, SessionMode, SessionModeState } from "@agentclientprotocol/sdk";
import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { isFileMutationTool, isMcpTool, isShellTool } from "./tool-facts.ts";

export type PermissionMode = "read-only" | "ask" | "full-access";

export const PERMISSION_MODES: readonly PermissionMode[] = ["read-only", "ask", "full-access"];

export const DEFAULT_PERMISSION_MODE: PermissionMode = "ask";

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

const MODE_LABELS: Record<PermissionMode, { name: string; description: string }> = {
  "read-only": { name: "Read-only", description: "Edits, writes, and shell commands are blocked" },
  ask: { name: "Ask before changes", description: "Edits, writes, and shell commands ask for permission" },
  "full-access": { name: "Full access", description: "No permission prompts (pi's native behavior)" },
};

export function availableModes(): SessionMode[] {
  return PERMISSION_MODES.map((id) => ({ id, ...MODE_LABELS[id] }));
}

export function modeState(current: PermissionMode): SessionModeState {
  return { currentModeId: current, availableModes: availableModes() };
}

/** Tools that read only and never need gating. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

export type ToolRisk = "read" | "mutate";

export function classifyToolRisk(toolName: string): ToolRisk {
  if (READ_ONLY_TOOLS.has(toolName)) return "read";
  if (isShellTool(toolName) || isFileMutationTool(toolName)) return "mutate";
  if (isMcpTool(toolName)) return "mutate";
  // Extension tools are unknown; treat as mutating unless they look like reads.
  if (/^(get|list|read|search|find|grep|glob|fetch|view|show|inspect|query|browse)[_A-Z]?/i.test(toolName))
    return "read";
  return "mutate";
}

export const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow this tool (session)", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  { optionId: "reject-always", name: "Always reject this tool (session)", kind: "reject_always" },
];

export type PermissionDecision = "allow" | "reject" | "cancelled";

export interface PermissionRequester {
  (event: ToolCallEvent): Promise<{ decision: PermissionDecision; remember: boolean }>;
}

/**
 * Per-session permission policy state. `alwaysAllow` / `alwaysReject` remember
 * "always" answers for the lifetime of the session (never persisted).
 */
export class PermissionPolicy {
  mode: PermissionMode;
  readonly alwaysAllow = new Set<string>();
  readonly alwaysReject = new Set<string>();

  constructor(mode: PermissionMode = DEFAULT_PERMISSION_MODE) {
    this.mode = mode;
  }

  /** Gate one tool call; returns pi's `ToolCallEventResult` (undefined = proceed). */
  async gate(event: ToolCallEvent, request: PermissionRequester): Promise<ToolCallEventResult | undefined> {
    const risk = classifyToolRisk(event.toolName);
    if (risk === "read") return undefined;
    if (this.mode === "full-access") return undefined;
    if (this.mode === "read-only") {
      return {
        block: true,
        reason: `Blocked: the session is in read-only mode (${event.toolName} would modify state).`,
      };
    }
    if (this.alwaysAllow.has(event.toolName)) return undefined;
    if (this.alwaysReject.has(event.toolName)) {
      return { block: true, reason: `Blocked: the user always rejects ${event.toolName} in this session.` };
    }
    const { decision, remember } = await request(event);
    if (decision === "allow") {
      if (remember) this.alwaysAllow.add(event.toolName);
      return undefined;
    }
    if (decision === "reject") {
      if (remember) this.alwaysReject.add(event.toolName);
      return { block: true, reason: `The user rejected this ${event.toolName} call.` };
    }
    return { block: true, reason: "The permission request was cancelled.", terminate: true };
  }
}

export function decisionFromOptionId(optionId: string): { decision: PermissionDecision; remember: boolean } {
  switch (optionId) {
    case "allow-once":
      return { decision: "allow", remember: false };
    case "allow-always":
      return { decision: "allow", remember: true };
    case "reject-always":
      return { decision: "reject", remember: true };
    case "reject-once":
      return { decision: "reject", remember: false };
    default:
      return { decision: "cancelled", remember: false };
  }
}
