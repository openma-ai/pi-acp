/**
 * `@juicesharp/rpiv-todo` → ACP `plan`.
 *
 * The extension's `todo` tool returns the complete task state in every result's
 * `details` (`{ action, params, tasks, nextId, error? }`), which is also how
 * the extension itself replays state from the session branch. The adapter
 * reads the same snapshot and projects live tasks as a whole-list ACP plan.
 */

import type { PlanEntry } from "@agentclientprotocol/sdk";

export const RPIV_TODO_TOOL = "todo";

interface RpivTask {
  id: number;
  subject: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  activeForm?: string;
  blockedBy?: number[];
}

interface RpivTaskDetails {
  tasks: RpivTask[];
  nextId: number;
}

function isTaskDetails(value: unknown): value is RpivTaskDetails {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record["tasks"]) && typeof record["nextId"] === "number";
}

/** Plan entries from a `todo` tool result's `details`; undefined when it is not a snapshot. */
export function planFromRpivTodo(toolName: string, details: unknown): PlanEntry[] | undefined {
  if (toolName !== RPIV_TODO_TOOL || !isTaskDetails(details)) return undefined;
  const entries: PlanEntry[] = [];
  for (const task of details.tasks) {
    if (task === null || typeof task !== "object" || task.status === "deleted") continue;
    const subject = typeof task.subject === "string" ? task.subject.trim() : "";
    if (subject.length === 0) continue;
    const status =
      task.status === "in_progress" || task.status === "completed" || task.status === "pending"
        ? task.status
        : "pending";
    const content =
      status === "in_progress" && typeof task.activeForm === "string" && task.activeForm.trim().length > 0
        ? `${subject} — ${task.activeForm.trim()}`
        : subject;
    entries.push({ content, status, priority: "medium" });
  }
  return entries;
}
