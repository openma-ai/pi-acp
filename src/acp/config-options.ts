/**
 * ACP session config options for a pi session: model, thinking
 * level, and auto-compaction. Options are derived from pi’s current session.
 */

import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

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

export interface ConfigOptionSurface {
  /** Client advertised `session.configOptions.boolean`; otherwise booleans degrade to selects. */
  booleanOptions: boolean;
}

export function parseBooleanOptionValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const lowered = value.toLowerCase();
  if (["true", "on", "enabled", "1"].includes(lowered)) return true;
  if (["false", "off", "disabled", "0"].includes(lowered)) return false;
  return undefined;
}

export function buildConfigOptions(
  session: AgentSession,
  surface: ConfigOptionSurface = { booleanOptions: true },
): SessionConfigOption[] {
  const options: SessionConfigOption[] = [];

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

  const autoCompaction = {
    id: CONFIG_AUTO_COMPACTION,
    name: "Auto-compaction",
    category: "model_config",
    description: "Summarize context automatically when it nears the model's window",
  };
  if (surface.booleanOptions) {
    options.push({ type: "boolean", ...autoCompaction, currentValue: session.autoCompactionEnabled });
  } else {
    options.push({
      type: "select",
      ...autoCompaction,
      currentValue: session.autoCompactionEnabled ? "on" : "off",
      options: [
        { value: "on", name: "On" },
        { value: "off", name: "Off" },
      ],
    });
  }

  return options;
}
