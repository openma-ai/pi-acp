import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { findModel } from "../src/acp/config-options.ts";
import { modelReferenceCandidates } from "../src/acp/model-aliases.ts";

const models = [
  { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
  { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  { provider: "cloudflare-ai-gateway", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  { provider: "azure", id: "gpt-4o", name: "GPT-4o" },
  { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
] as Model<string>[];

describe("renamed catalog ids", () => {
  it("resolves deepseek-v4-flash and dotted Claude ids onto the 1.1.0 catalog", () => {
    expect(findModel(models, "deepseek/deepseek-v4-flash")?.id).toBe("deepseek-flash");
    expect(findModel(models, "deepseek-v4-flash")?.id).toBe("deepseek-flash");
    expect(findModel(models, "deepseek/deepseek-v4-flash-vision-exp")?.id).toBe("deepseek-flash");
    expect(findModel(models, "cloudflare-ai-gateway/claude-haiku-4.5")?.id).toBe("claude-haiku-4-5");
    expect(findModel(models, "azure-openai-responses/gpt-4o")?.id).toBe("gpt-4o");
    expect(findModel(models, "deepseek/deepseek-v4-pro")?.id).toBe("deepseek-v4-pro");
    expect(findModel(models, "openai/gpt-5.4")?.id).toBe("gpt-5.4");
  });

  it("keeps a thinking suffix on the aliased CLI reference", () => {
    expect(modelReferenceCandidates("deepseek/deepseek-v4-flash:low")).toContain(
      "deepseek/deepseek-flash:low",
    );
    expect(modelReferenceCandidates("openrouter/some-model:exacto")).toEqual([
      "openrouter/some-model:exacto",
    ]);
  });
});
