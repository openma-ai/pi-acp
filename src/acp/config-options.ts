/**
 * ACP session config options for a pi session: permission mode, model, thinking
 * level, and auto-compaction. Everything also lives in `modes` for clients that
 * only render one of the two surfaces.
 */

import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { availableModes, type PermissionMode } from "./permissions.ts";

export const CONFIG_MODE = "mode";
export const CONFIG_MODEL = "model";
export const CONFIG_THINKING = "thinking";
export const CONFIG_AUTO_COMPACTION = "auto_compaction";

export function modelValue(model: Pick<Model<string>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

/** Resolve `provider/id` (preferred) or a bare model id against the available models. */
export function findModel(models: readonly Model<string>[], value: string): Model<string> | undefined {
  const exact = models.find((model) => modelValue(model) === value);
  if (exact !== undefined) return exact;
  const byId = models.filter((model) => model.id === value);
  if (byId.length === 1) return byId[0];
  const lowered = value.toLowerCase();
  const fuzzy = models.filter(
    (model) =>
      modelValue(model).toLowerCase().includes(lowered) || model.name.toLowerCase().includes(lowered),
  );
  return fuzzy.length === 1 ? fuzzy[0] : undefined;
}

export function buildConfigOptions(session: AgentSession, mode: PermissionMode): SessionConfigOption[] {
  const options: SessionConfigOption[] = [
    {
      type: "select",
      id: CONFIG_MODE,
      name: "Permissions",
      category: "mode",
      description: "What the agent may do without asking",
      currentValue: mode,
      options: availableModes().map((entry) => ({
        value: entry.id,
        name: entry.name,
        description: entry.description ?? null,
      })),
    },
  ];

  const available = session.modelRuntime.getAvailableSnapshot();
  const current = session.model;
  const seen = new Set<string>();
  const modelOptions: { value: string; name: string; description: string | null }[] = [];
  const push = (model: Model<string>): void => {
    const value = modelValue(model);
    if (seen.has(value)) return;
    seen.add(value);
    modelOptions.push({
      value,
      name: model.name,
      description: `${model.provider} · ${model.id}`,
    });
  };
  if (current !== undefined) push(current);
  for (const model of available) push(model);
  if (modelOptions.length > 0) {
    // Group by provider when more than one provider is live; flat list otherwise.
    const providers = new Set(modelOptions.map((option) => option.value.split("/", 1)[0]));
    const currentValue = current !== undefined ? modelValue(current) : modelOptions[0]!.value;
    if (providers.size > 1) {
      const groups = [...providers].map((provider) => ({
        group: provider ?? "other",
        name: provider ?? "other",
        options: modelOptions.filter((option) => option.value.split("/", 1)[0] === provider),
      }));
      options.push({
        type: "select",
        id: CONFIG_MODEL,
        name: "Model",
        category: "model",
        currentValue,
        options: groups,
      });
    } else {
      options.push({
        type: "select",
        id: CONFIG_MODEL,
        name: "Model",
        category: "model",
        currentValue,
        options: modelOptions,
      });
    }
  }

  if (session.supportsThinking()) {
    const levels = session.getAvailableThinkingLevels();
    if (levels.length >= 2) {
      options.push({
        type: "select",
        id: CONFIG_THINKING,
        name: "Thinking",
        category: "thought_level",
        description: "Reasoning effort for this session",
        currentValue: session.thinkingLevel,
        options: levels.map((level) => ({ value: level, name: level })),
      });
    }
  }

  options.push({
    type: "boolean",
    id: CONFIG_AUTO_COMPACTION,
    name: "Auto-compaction",
    category: "model_config",
    description: "Summarize context automatically when it nears the model's window",
    currentValue: session.autoCompactionEnabled,
  });

  return options;
}
