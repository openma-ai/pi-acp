/**
 * Model/thinking changes persist as pi's global defaults, and `_session/steering`
 * is delivered through the real pi runtime (faux model, real ACP session).
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { Context, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, Harness } from "./helpers/harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function settingsPath(h: Harness): string {
  return join(h.agentDir, "settings.json");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function currentValue(options: SessionConfigOption[], id: string): string | boolean | null | undefined {
  const option = options.find((item) => item.id === id);
  if (option === undefined || !("currentValue" in option)) return undefined;
  return option.currentValue;
}

function contextText(context: Context): string {
  const chunks: string[] = [];
  for (const message of context.messages) {
    const content = message.content;
    if (typeof content === "string") {
      chunks.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
        chunks.push(block.text);
      }
    }
  }
  return chunks.join("\n");
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 20_000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readSettings(path: string): {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: string;
  };
}

describe("model and thinking changes persist as pi defaults", () => {
  it("writes settings.json and switches the live session, including the next model call", async () => {
    harness = await Harness.create();
    await harness.initialize();
    const sessionId = await harness.newSession();
    await harness.settle();
    const path = settingsPath(harness);
    const before = sha256(path);
    const live = harness.agent["sessions"].get(sessionId)!;
    expect(live.session.model?.id).toBe("faux-1");

    const levels = live.session.getAvailableThinkingLevels();
    const initialThinking = live.session.thinkingLevel;
    const nextThinking = levels.find((level) => level !== initialThinking);
    expect(nextThinking).toBeDefined();

    const thinking = await harness.client.setSessionConfigOption({
      sessionId,
      configId: "thinking",
      value: nextThinking!,
    });
    expect(currentValue(thinking.configOptions, "thinking")).toBe(nextThinking);
    expect(live.session.thinkingLevel).toBe(nextThinking);
    expect(sha256(path)).not.toBe(before);
    expect(readSettings(path).defaultThinkingLevel).toBe(nextThinking);

    const otherThinking = levels.find((level) => level !== nextThinking);
    expect(otherThinking).toBeDefined();
    const thinkingBeforeSlash = sha256(path);
    const slashThinking = await harness.client.prompt({
      sessionId,
      prompt: [{ type: "text", text: `/thinking ${otherThinking}` }],
    });
    expect(slashThinking.stopReason).toBe("end_turn");
    expect(live.session.thinkingLevel).toBe(otherThinking);
    expect(sha256(path)).not.toBe(thinkingBeforeSlash);
    expect(readSettings(path).defaultThinkingLevel).toBe(otherThinking);

    const modelBefore = sha256(path);
    const switched = await harness.client.setSessionConfigOption({
      sessionId,
      configId: "model",
      value: "faux/faux-2",
    });
    expect(currentValue(switched.configOptions, "model")).toBe("faux/faux-2");
    expect(live.session.model?.provider).toBe("faux");
    expect(live.session.model?.id).toBe("faux-2");
    expect(sha256(path)).not.toBe(modelBefore);
    expect(readSettings(path)).toMatchObject({ defaultProvider: "faux", defaultModel: "faux-2" });

    const legacyBefore = sha256(path);
    const legacy = await harness.client.extMethod("session/set_model", {
      sessionId,
      modelId: "faux/faux-1",
    });
    expect(legacy).toEqual({});
    expect(live.session.model?.id).toBe("faux-1");
    expect(sha256(path)).not.toBe(legacyBefore);
    expect(readSettings(path).defaultModel).toBe("faux-1");

    const slashBefore = sha256(path);
    const slashModel = await harness.client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "/model faux/faux-2" }],
    });
    expect(slashModel.stopReason).toBe("end_turn");
    expect(live.session.model?.id).toBe("faux-2");
    expect(sha256(path)).not.toBe(slashBefore);
    expect(readSettings(path)).toMatchObject({ defaultProvider: "faux", defaultModel: "faux-2" });

    let seenModel: string | undefined;
    harness.respond((context, _options, _state, model: Model<string>) => {
      seenModel = `${model.provider}/${model.id}`;
      expect(contextText(context)).toContain("which model");
      return fauxAssistantMessage("faux-2");
    });
    const prompted = await harness.client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "which model" }],
    });
    expect(prompted.stopReason).toBe("end_turn");
    expect(seenModel).toBe("faux/faux-2");
  });
});

describe("steering at the next model boundary", () => {
  it("injects _session/steering into the next model call and leaves settings.json unchanged", async () => {
    harness = await Harness.create();
    const active = harness;
    const init = await active.initialize();
    expect(init._meta).toMatchObject({ steering: { supported: true } });
    const sessionId = await active.newSession();
    await active.settle();
    const path = settingsPath(active);
    const before = sha256(path);
    const gate = join(active.workspace, "release-tool");
    const calls: { model: string; text: string }[] = [];

    const record = (context: Context, model: Model<string>) => {
      calls.push({ model: `${model.provider}/${model.id}`, text: contextText(context) });
    };
    active.respond(
      (context, _options, _state, model) => {
        record(context, model);
        return fauxAssistantMessage([
          fauxToolCall("bash", { command: `while [ ! -f '${gate}' ]; do sleep 0.05; done` }),
        ]);
      },
      (context, _options, _state, model) => {
        record(context, model);
        return fauxAssistantMessage("after-steer");
      },
      (context, _options, _state, model) => {
        record(context, model);
        return fauxAssistantMessage("extra");
      },
    );

    const promptPromise = active.client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "run the waiter" }],
    });
    await waitFor(
      () => active.updatesFor(sessionId).some((update) => update.sessionUpdate === "tool_call"),
      "tool_call",
    );

    const injected = await active.client.extMethod("_session/steering", {
      sessionId,
      prompt: [{ type: "text", text: "STEER_TOKEN from the user" }],
      _meta: { steering: { idleBehavior: "promptRequired" } },
    });
    expect(injected).toEqual({ outcome: "injected" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).not.toContain("STEER_TOKEN");
    expect(sha256(path)).toBe(before);

    writeFileSync(gate, "go\n");
    const response = await promptPromise;
    expect(response.stopReason).toBe("end_turn");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1]?.text).toContain("STEER_TOKEN from the user");
    expect(calls[1]?.model).toBe("faux/faux-1");
    expect(active.text(sessionId)).toContain("after-steer");
    expect(sha256(path)).toBe(before);
  });
});
