/**
 * `update_plan`: an ACP-native plan tool for pi.
 *
 * pi has no built-in todo/plan tool. This custom tool lets the model publish a
 * whole-list plan snapshot which the projection turns into ACP `plan` updates,
 * so editors render the same plan panel they show for other ACP agents.
 */

import type { PlanEntry } from "@agentclientprotocol/sdk";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const PLAN_TOOL_NAME = "update_plan";

const planEntrySchema = Type.Object({
  content: Type.String({ description: "Short description of the step" }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
    description: "Current status of the step",
  }),
  priority: Type.Optional(
    Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
      description: "Relative priority (default medium)",
    }),
  ),
});

const planSchema = Type.Object({
  entries: Type.Array(planEntrySchema, {
    description: "The complete plan. Replaces the previous plan entirely.",
  }),
});

export interface PlanToolDetails {
  entries: PlanEntry[];
}

/** Normalize raw tool arguments into ACP plan entries (defensive: model output). */
export function planEntriesFromArgs(args: unknown): PlanEntry[] | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const entries = (args as Record<string, unknown>)["entries"];
  if (!Array.isArray(entries)) return undefined;
  const result: PlanEntry[] = [];
  for (const raw of entries) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const content = typeof entry["content"] === "string" ? entry["content"].trim() : "";
    if (content.length === 0) continue;
    const status = entry["status"];
    const priority = entry["priority"];
    result.push({
      content,
      status: status === "in_progress" || status === "completed" ? status : "pending",
      priority: priority === "high" || priority === "low" ? priority : "medium",
    });
  }
  return result;
}

export function createPlanTool(): ToolDefinition {
  return defineTool({
    name: PLAN_TOOL_NAME,
    label: "Update plan",
    description:
      "Publish or replace your step-by-step plan for the current task. Call it when you start a " +
      "multi-step task and again whenever a step changes status. Always send the complete list.",
    promptSnippet: "Publish a step-by-step plan the user can follow (call again to update statuses)",
    promptGuidelines: [
      "For tasks with several steps, call update_plan first and keep exactly one step in_progress; mark steps completed as you finish them.",
    ],
    parameters: planSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const entries = planEntriesFromArgs(params) ?? [];
      const done = entries.filter((entry) => entry.status === "completed").length;
      const lines = entries.map((entry) => {
        const marker = entry.status === "completed" ? "[x]" : entry.status === "in_progress" ? "[>]" : "[ ]";
        return `${marker} ${entry.content}`;
      });
      return {
        content: [
          {
            type: "text",
            text: `Plan updated (${done}/${entries.length} completed).\n${lines.join("\n")}`,
          },
        ],
        details: { entries } satisfies PlanToolDetails,
      };
    },
  }) as unknown as ToolDefinition;
}
