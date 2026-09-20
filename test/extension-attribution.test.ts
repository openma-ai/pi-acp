/**
 * E2E: extension attribution surface — inventory in session responses,
 * `_meta.pi.extension` on tool calls, live `custom_message` / `custom_entry`
 * with full payloads (the raw material for client-side extension adapters).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, Harness } from "./helpers/harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const TRACKER_EXTENSION = `
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "track_job",
    label: "Track job",
    description: "Track a background job",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_toolCallId, params) {
      pi.sendMessage({ customType: "tracker:job", content: "job " + params.id + " started", display: true, details: { id: params.id, state: "running", nested: { deep: [1, 2] } } });
      pi.appendEntry("tracker:marker", { id: params.id, at: 1 });
      return { content: [{ type: "text", text: "tracking " + params.id }], details: { id: params.id } };
    },
  });
  pi.registerCommand("tracker", { description: "tracker command", handler: async () => {} });
  pi.registerMessageRenderer("tracker:job", () => undefined);
  pi.registerEntryRenderer("tracker:marker", () => undefined);
}
`;

function install(h: Harness): void {
  // pi aliases `typebox` for extensions, so a single file is enough.
  const dir = join(h.agentDir, "extensions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tracker.js"), TRACKER_EXTENSION);
}

function metaEvents(h: Harness, sessionId: string, event: string): Record<string, unknown>[] {
  return h
    .updatesFor(sessionId)
    .filter((u) => u.sessionUpdate === "session_info_update")
    .map((u) => (u._meta as { pi?: Record<string, unknown> } | undefined)?.pi)
    .filter((m): m is Record<string, unknown> => m?.["event"] === event);
}

describe("extension attribution", () => {
  it("lists loaded extensions with owned tools, commands, and custom types", async () => {
    harness = await Harness.create({ settings: { permissionMode: "full-access" } });
    install(harness);
    await harness.initialize();
    const created = await harness.client.newSession({ cwd: harness.workspace, mcpServers: [] });
    const extensions = (created._meta as { pi: { extensions: Record<string, unknown>[] } }).pi.extensions;
    const tracker = extensions.find((e) => (e["tools"] as string[]).includes("track_job"));
    expect(tracker).toMatchObject({
      source: expect.any(String),
      scope: "user",
      tools: ["track_job"],
      commands: ["tracker"],
      customTypes: expect.arrayContaining(["tracker:job", "tracker:marker"]),
    });
    expect(typeof tracker?.["path"]).toBe("string");
    expect(extensions.some((e) => e["path"] === "openma-acp-permissions")).toBe(false);
  });

  it("attributes tool calls to their extension and forwards custom messages with details", async () => {
    harness = await Harness.create({ settings: { permissionMode: "full-access" } });
    install(harness);
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(
      fauxAssistantMessage([fauxToolCall("track_job", { id: "j1" })]),
      fauxAssistantMessage("ok"),
    );
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "track" }] });
    await harness.settle();

    const call = harness.updatesFor(sessionId).find((u) => u.sessionUpdate === "tool_call");
    expect(call).toMatchObject({
      name: "track_job",
      _meta: { pi: { extension: expect.stringContaining("tracker") } },
    });

    const messages = metaEvents(harness, sessionId, "custom_message");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      customType: "tracker:job",
      display: true,
      text: "job j1 started",
      details: { id: "j1", state: "running", nested: { deep: [1, 2] } },
      truncated: false,
    });

    const entries = metaEvents(harness, sessionId, "custom_entry");
    expect(entries).toEqual([
      expect.objectContaining({ customType: "tracker:marker", data: { id: "j1", at: 1 }, truncated: false }),
    ]);

    // Built-in tools carry no extension attribution.
    harness.respond(fauxAssistantMessage([fauxToolCall("ls", { path: "." })]), fauxAssistantMessage("ok"));
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "ls" }] });
    const ls = harness
      .updatesFor(sessionId)
      .filter((u) => u.sessionUpdate === "tool_call")
      .at(-1);
    expect(ls?._meta).toBeUndefined();
  });

  it("replays custom messages and entries with payloads on session/load", async () => {
    harness = await Harness.create({ settings: { permissionMode: "full-access" } });
    install(harness);
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(
      fauxAssistantMessage([fauxToolCall("track_job", { id: "j2" })]),
      fauxAssistantMessage("ok"),
    );
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "track" }] });
    await harness.client.closeSession({ sessionId });
    harness.notifications.length = 0;
    await harness.client.loadSession({ sessionId, cwd: harness.workspace, mcpServers: [] });
    await harness.settle();
    expect(metaEvents(harness, sessionId, "custom_message")[0]).toMatchObject({
      customType: "tracker:job",
      details: { id: "j2", state: "running" },
    });
    expect(metaEvents(harness, sessionId, "custom_entry")[0]).toMatchObject({
      customType: "tracker:marker",
      data: { id: "j2", at: 1 },
    });
  });
});
