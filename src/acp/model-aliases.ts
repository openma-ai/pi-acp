/**
 * Catalog ids renamed between pi 0.85 and 1.1.0.
 *
 * ACP clients and saved settings still send the old ids (`deepseek-v4-flash`,
 * dotted Claude ids on Cloudflare AI Gateway, `azure-openai-responses`).
 * Resolution tries the current id when the old one is not in the catalog.
 */

import { resolveCliModel, type ModelRuntime } from "@earendil-works/pi-coding-agent";

const THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Old model id → current catalog id, matched on the id (not the provider). */
const MODEL_ID_ALIASES: Readonly<Record<string, string>> = {
  "deepseek-v4-flash": "deepseek-flash",
  // The vision preview was folded into deepseek-flash, which accepts images.
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
};

/** Old provider id → current provider id. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  "azure-openai-responses": "azure",
};

function splitThinking(value: string): { model: string; thinking?: string } {
  const index = value.lastIndexOf(":");
  if (index <= 0) return { model: value };
  const suffix = value.slice(index + 1);
  if (!THINKING_LEVELS.has(suffix)) return { model: value };
  return { model: value.slice(0, index), thinking: suffix };
}

function aliasModelIds(value: string): string[] {
  const out: string[] = [];
  const push = (next: string): void => {
    if (!out.includes(next)) out.push(next);
  };
  push(value);
  const slash = value.indexOf("/");
  const provider = slash > 0 ? value.slice(0, slash) : undefined;
  const id = slash > 0 ? value.slice(slash + 1) : value;
  const nextProvider = provider !== undefined ? (PROVIDER_ALIASES[provider] ?? provider) : undefined;
  const ids = new Set<string>([id]);
  const renamed = MODEL_ID_ALIASES[id];
  if (renamed !== undefined) ids.add(renamed);
  // Cloudflare AI Gateway renamed `claude-haiku-4.5` to `claude-haiku-4-5`.
  // Ids that still contain a digit dot (gpt-5.4) only match when that form exists.
  const dotted = id.replace(/(\d)\.(\d)/g, "$1-$2");
  if (dotted !== id) ids.add(dotted);
  for (const modelId of ids) {
    if (nextProvider !== undefined) push(`${nextProvider}/${modelId}`);
    else push(modelId);
  }
  return out;
}

/** Model references to try, oldest spelling first, thinking suffix preserved. */
export function modelReferenceCandidates(value: string): string[] {
  const { model, thinking } = splitThinking(value);
  return aliasModelIds(model).map((id) => (thinking !== undefined ? `${id}:${thinking}` : id));
}

/** Model id candidates with any `:thinking` suffix removed, for catalog lookup. */
export function modelLookupCandidates(value: string): string[] {
  return aliasModelIds(splitThinking(value).model);
}

export function resolveAliasedCliModel(options: {
  cliModel: string;
  modelRuntime: ModelRuntime;
}): ReturnType<typeof resolveCliModel> {
  let last = resolveCliModel({ cliModel: options.cliModel, modelRuntime: options.modelRuntime });
  if (last.model !== undefined) return last;
  for (const candidate of modelReferenceCandidates(options.cliModel)) {
    if (candidate === options.cliModel) continue;
    const resolved = resolveCliModel({ cliModel: candidate, modelRuntime: options.modelRuntime });
    if (resolved.model !== undefined) return resolved;
    last = resolved;
  }
  return last;
}
