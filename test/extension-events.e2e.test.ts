/**
 * E2E: extension event bus → `extension_event` metadata, and `_pi/emit_event` back in.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Harness } from "./helpers/harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const DEMO_EXTENSION = `
export default function (pi) {
  pi.registerCommand("demo-events", {
    description: "emit demo events",
    handler: async () => {
      pi.events.emit("demo:job-started", { id: "job-1", detail: { fn: () => 1 } });
      pi.events.emit("demo:job-update", { id: "job-1", progress: 50 });
      pi.events.emit("demo:job-complete", { runId: "job-1", results: [1, 2] });
      pi.events.emit("plain-ping", "hello");
    },
  });
  pi.events.on("acp:ping", (data) => {
    pi.events.emit("demo:pong", { ...data, id: "pong-1" });
  });
}
`;

function extensionEvents(h: Harness, sessionId: string): Record<string, unknown>[] {
  return h
    .updatesFor(sessionId)
    .filter((u) => u.sessionUpdate === "session_info_update")
    .map((u) => (u._meta as { pi?: Record<string, unknown> } | undefined)?.pi)
    .filter((m): m is Record<string, unknown> => m?.["event"] === "extension_event");
}

describe("extension events over ACP", () => {
  it("forwards pi.events traffic with inferred phase and correlation id", async () => {
    harness = await Harness.create();
    mkdirSync(join(harness.agentDir, "extensions"), { recursive: true });
    writeFileSync(join(harness.agentDir, "extensions", "demo-events.js"), DEMO_EXTENSION);
    await harness.initialize();
    const sessionId = await harness.newSession();
    await harness.settle();
    const commands = harness
      .updatesFor(sessionId)
      .filter((u) => u.sessionUpdate === "available_commands_update")
      .at(-1);
    expect(
      commands?.sessionUpdate === "available_commands_update" &&
        commands.availableCommands.some((c) => c.name === "demo-events"),
    ).toBe(true);

    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "/demo-events" }] });
    await harness.settle();
    const events = extensionEvents(harness, sessionId);
    expect(events.map((e) => [e["channel"], e["phase"], e["correlationId"]])).toEqual([
      ["demo:job-started", "started", "job-1"],
      ["demo:job-update", "update", "job-1"],
      ["demo:job-complete", "completed", "job-1"],
      ["plain-ping", undefined, undefined],
    ]);
    expect(events[0]).toMatchObject({
      inferred: true,
      namespace: "demo",
      name: "job-started",
      payload: { id: "job-1", detail: {} },
      truncated: true,
    });
    expect(events[3]).toMatchObject({ namespace: "pi", payload: "hello", truncated: false });
  });

  it("delivers _pi/emit_event to extension subscribers", async () => {
    harness = await Harness.create();
    mkdirSync(join(harness.agentDir, "extensions"), { recursive: true });
    writeFileSync(join(harness.agentDir, "extensions", "demo-events.js"), DEMO_EXTENSION);
    await harness.initialize();
    const sessionId = await harness.newSession();
    await harness.client.extMethod("_pi/emit_event", {
      sessionId,
      channel: "acp:ping",
      data: { from: "client" },
    });
    await harness.settle();
    const events = extensionEvents(harness, sessionId);
    // The injected event itself is not echoed; the extension's reaction is.
    expect(events.map((e) => e["channel"])).toEqual(["demo:pong"]);
    expect(events[0]).toMatchObject({ correlationId: "pong-1", payload: { from: "client", id: "pong-1" } });
    expect(events[0]).not.toHaveProperty("phase");
    await expect(harness.client.extMethod("_pi/emit_event", { sessionId })).rejects.toThrow();
  });
});
