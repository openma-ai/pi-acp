/**
 * `@plannotator/pi-extension` → ACP plan mode + plan checklist.
 *
 * Plannotator owns a three-phase workflow (idle → planning → executing) with a
 * documented event API: `plannotator:request` `{ action: "plan-mode", payload:
 * { mode }, respond }` answers with the resulting phase. The approved plan is a
 * markdown file whose checkbox lines (`- [ ]` / `- [x]`, the extension's own
 * format) are its execution checklist; `plannotator_mark_done` ticks them.
 *
 * ACP mapping (same ids Codex uses, so clients that already render a
 * `collaboration_mode` control and a `/plan` command work unchanged):
 * - config option `collaboration_mode`: `default` | `plan`
 * - `/plan` command with a `setConfigOption` commandAction
 * - the checklist as a whole-list ACP `plan` while a plan is executing
 */

import type { AvailableCommand, PlanEntry, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { errorMessage, logDebug } from "../../log.ts";

export const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request";
export const PLANNOTATOR_STATE_ENTRY = "plannotator";
export const PLANNOTATOR_EXECUTE_ENTRY = "plannotator-execute";
export const PLANNOTATOR_COMPLETE_MESSAGE = "plannotator-complete";
export const PLANNOTATOR_SUBMIT_TOOL = "plannotator_submit_plan";
export const PLANNOTATOR_MARK_DONE_TOOL = "plannotator_mark_done";

export const COLLABORATION_MODE_OPTION = "collaboration_mode";
export const COLLABORATION_DEFAULT = "default";
export const COLLABORATION_PLAN = "plan";
export const PLAN_COMMAND = "plan";

export type PlannotatorPhase = "idle" | "planning" | "executing";

interface PlannotatorState {
  phase?: PlannotatorPhase;
  lastSubmittedPath?: string | null;
}

/** The extension's own checkbox pattern (generated/checklist.ts). */
const CHECKLIST_PATTERN = /^[-*][^\S\n]*\[([ xX])\][^\S\n]+(.+)$/gm;

/** Latest persisted plannotator state on the active branch (what the extension itself restores from). */
export function readPlannotatorState(session: AgentSession): PlannotatorState | undefined {
  let state: PlannotatorState | undefined;
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === PLANNOTATOR_STATE_ENTRY) {
      const data = entry.data as PlannotatorState | undefined;
      if (data !== undefined && data !== null) state = data;
    }
  }
  return state;
}

export function collaborationModeFromPhase(phase: PlannotatorPhase | undefined): string {
  return phase === "planning" ? COLLABORATION_PLAN : COLLABORATION_DEFAULT;
}

/** Checklist entries of the executing plan; undefined when no plan is executing. */
export function planFromPlannotator(session: AgentSession, cwd: string): PlanEntry[] | undefined {
  const state = readPlannotatorState(session);
  if (state?.phase !== "executing" || typeof state.lastSubmittedPath !== "string") return undefined;
  const path = resolve(cwd, state.lastSubmittedPath);
  if (!existsSync(path)) return undefined;
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error: unknown) {
    logDebug(`plannotator plan ${path} unreadable: ${errorMessage(error)}`);
    return undefined;
  }
  const entries: PlanEntry[] = [];
  for (const match of content.matchAll(CHECKLIST_PATTERN)) {
    const text = match[2]?.trim() ?? "";
    if (text.length === 0) continue;
    entries.push({ content: text, status: match[1] !== " " ? "completed" : "pending", priority: "medium" });
  }
  return entries;
}

/** Tools/entries whose completion means the checklist may have changed. */
export function plannotatorPlanChanged(event: { toolName?: string; customType?: string }): boolean {
  return (
    event.toolName === PLANNOTATOR_SUBMIT_TOOL ||
    event.toolName === PLANNOTATOR_MARK_DONE_TOOL ||
    event.customType === PLANNOTATOR_EXECUTE_ENTRY ||
    event.customType === PLANNOTATOR_STATE_ENTRY ||
    event.customType === PLANNOTATOR_COMPLETE_MESSAGE
  );
}

export function collaborationModeOption(phase: PlannotatorPhase | undefined): SessionConfigOption {
  return {
    type: "select",
    id: COLLABORATION_MODE_OPTION,
    name: "Collaboration mode",
    category: "mode",
    description: "Plan mode (Plannotator): write and review a plan before making changes",
    currentValue: collaborationModeFromPhase(phase),
    options: [
      { value: COLLABORATION_DEFAULT, name: "Default", description: "Work directly" },
      {
        value: COLLABORATION_PLAN,
        name: "Plan",
        description:
          phase === "executing" ? "Executing an approved plan" : "Write a plan and review it in Plannotator",
      },
    ],
  };
}

export const PLAN_COMMAND_ENTRY: AvailableCommand = {
  name: PLAN_COMMAND,
  description: "Turn Plannotator plan mode on.",
  _meta: {
    commandAction: {
      kind: "setConfigOption",
      configId: COLLABORATION_MODE_OPTION,
      value: COLLABORATION_PLAN,
      resetValue: COLLABORATION_DEFAULT,
      presentation: "state",
    },
  },
};

type PlanModeRequestMode = "enter" | "exit" | "toggle" | "status";

interface PlannotatorResponse {
  status: "handled" | "unavailable" | "error";
  result?: { phase?: PlannotatorPhase };
  error?: string;
}

/**
 * Drive plan mode through the extension's event API. `emit` publishes on the
 * session's extension bus. Resolves the resulting phase.
 */
export function requestPlanMode(
  emit: (channel: string, data: unknown) => void,
  mode: PlanModeRequestMode,
  timeoutMs = 5_000,
): Promise<PlannotatorPhase> {
  return new Promise<PlannotatorPhase>((resolvePhase, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Plannotator did not answer the plan-mode request")),
      timeoutMs,
    );
    emit(PLANNOTATOR_REQUEST_CHANNEL, {
      requestId: `acp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      action: "plan-mode",
      payload: { mode },
      respond: (response: PlannotatorResponse) => {
        clearTimeout(timer);
        if (response.status === "handled" && response.result?.phase !== undefined)
          resolvePhase(response.result.phase);
        else reject(new Error(response.error ?? `plan-mode request ${response.status}`));
      },
    });
  });
}
