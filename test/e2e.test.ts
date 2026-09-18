/**
 * End-to-end over an in-memory ACP connection with a faux model: no network,
 * real pi runtime (session files, tools, extensions gate, projection).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, Harness } from "./helpers/harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("initialize", () => {
  it("advertises the full capability surface and auth methods", async () => {
    harness = await Harness.create();
    const response = await harness.initialize();
    expect(response.protocolVersion).toBe(1);
    expect(response.agentCapabilities).toMatchObject({
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: false },
      sessionCapabilities: { list: {}, delete: {}, fork: {}, resume: {}, close: {} },
      auth: { logout: {} },
    });
    expect(response._meta).toMatchObject({ steering: { supported: true } });
    const ids = (response.authMethods ?? []).map((m) => m.id);
    expect(ids).toContain("pi-terminal-login");
    expect(ids).toContain("api-key:faux");
  });
});

describe("session/new + prompt", () => {
  it("streams text, thinking, and tool calls; returns usage", async () => {
    harness = await Harness.create({ settings: { permissionMode: "full-access" } });
    await harness.initialize();
    const sessionId = await harness.newSession();
    expect(sessionId).toMatch(/[0-9a-f-]{8,}/);
    await harness.settle();
    const kinds = harness.updatesFor(sessionId).map((u) => u.sessionUpdate);
    expect(kinds).toContain("available_commands_update");

    writeFileSync(join(harness.workspace, "note.txt"), "hello file\n");
    harness.respond(
      fauxAssistantMessage([
        fauxThinking("thinking"),
        fauxText("reading"),
        fauxToolCall("read", { path: "note.txt" }),
      ]),
      fauxAssistantMessage("done"),
    );
    const response = await harness.client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "read the note" }],
    });
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage).toMatchObject({ inputTokens: expect.any(Number) });

    const updates = harness.updatesFor(sessionId);
    expect(updates.some((u) => u.sessionUpdate === "agent_thought_chunk")).toBe(true);
    expect(harness.text(sessionId)).toContain("reading");
    expect(harness.text(sessionId)).toContain("done");
    const toolCall = updates.find((u) => u.sessionUpdate === "tool_call");
    expect(toolCall).toMatchObject({
      kind: "read",
      locations: [{ path: join(harness.workspace, "note.txt") }],
    });
    const completed = updates.find((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed");
    expect(completed).toBeDefined();
    expect(JSON.stringify(completed)).toContain("hello file");
    expect(harness.permissionRequests).toHaveLength(0);
  });

  it("returns config options and modes; switches model, thinking, and mode", async () => {
    harness = await Harness.create();
    await harness.initialize();
    const created = await harness.client.newSession({ cwd: harness.workspace, mcpServers: [] });
    expect(created.modes).toMatchObject({ currentModeId: "ask" });
    const ids = (created.configOptions ?? []).map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining(["mode", "model", "thinking", "auto_compaction"]));

    const model = await harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: "model",
      value: "faux/faux-2",
    });
    const modelOption = model.configOptions.find((o) => o.id === "model");
    expect(modelOption).toMatchObject({ currentValue: "faux/faux-2" });
    // faux-2 has no reasoning: the thinking option disappears.
    expect(model.configOptions.some((o) => o.id === "thinking")).toBe(false);

    await harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: "model",
      value: "faux-1",
    });
    const thinking = await harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: "thinking",
      value: "high",
    });
    expect(thinking.configOptions.find((o) => o.id === "thinking")).toMatchObject({ currentValue: "high" });

    await harness.client.setSessionMode({ sessionId: created.sessionId, modeId: "read-only" });
    await harness.settle();
    expect(
      harness
        .updatesFor(created.sessionId)
        .some((u) => u.sessionUpdate === "current_mode_update" && u.currentModeId === "read-only"),
    ).toBe(true);
    await expect(
      harness.client.setSessionMode({ sessionId: created.sessionId, modeId: "bogus" }),
    ).rejects.toThrow();
  });
});

describe("permissions", () => {
  it("asks before mutating tools in ask mode and honours rejection", async () => {
    harness = await Harness.create({
      onPermission: () => ({ outcome: { outcome: "selected", optionId: "reject-once" } }),
    });
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })]),
      fauxAssistantMessage("ok"),
    );
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "run" }] });
    expect(harness.permissionRequests).toHaveLength(1);
    expect(harness.permissionRequests[0]).toMatchObject({ toolCall: { kind: "execute", title: "echo hi" } });
    const failed = harness
      .updatesFor(sessionId)
      .find((u) => u.sessionUpdate === "tool_call_update" && u.status === "failed");
    expect(JSON.stringify(failed)).toContain("rejected");
  });

  it("blocks mutations in read-only mode without asking", async () => {
    harness = await Harness.create({ settings: { permissionMode: "read-only" } });
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(
      fauxAssistantMessage([fauxToolCall("write", { path: "x.txt", content: "no" })]),
      fauxAssistantMessage("ok"),
    );
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "write" }] });
    expect(harness.permissionRequests).toHaveLength(0);
    expect(existsSync(join(harness.workspace, "x.txt"))).toBe(false);
  });

  it("emits a structured diff for allowed edits", async () => {
    harness = await Harness.create({ settings: { permissionMode: "full-access" } });
    await harness.initialize();
    const sessionId = await harness.newSession();
    const file = join(harness.workspace, "a.txt");
    writeFileSync(file, "one\ntwo\n");
    harness.respond(
      fauxAssistantMessage([
        fauxToolCall("edit", { path: "a.txt", edits: [{ oldText: "two", newText: "2" }] }),
      ]),
      fauxAssistantMessage("edited"),
    );
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "edit" }] });
    expect(readFileSync(file, "utf8")).toBe("one\n2\n");
    const diff = harness
      .updatesFor(sessionId)
      .find((u) => u.sessionUpdate === "tool_call_update" && u.content?.some((c) => c.type === "diff"));
    expect(diff).toMatchObject({
      content: [{ type: "diff", path: file, oldText: "one\ntwo\n", newText: "one\n2\n" }],
    });
  });
});

describe("plans and slash commands", () => {
  it("publishes plan updates from update_plan", async () => {
    harness = await Harness.create({ settings: { permissionMode: "full-access" } });
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(
      fauxAssistantMessage([
        fauxToolCall("update_plan", { entries: [{ content: "step one", status: "in_progress" }] }),
      ]),
      fauxAssistantMessage("planned"),
    );
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "plan" }] });
    const plan = harness.updatesFor(sessionId).find((u) => u.sessionUpdate === "plan");
    expect(plan).toMatchObject({ entries: [{ content: "step one", status: "in_progress" }] });
  });

  it("runs adapter commands without a model turn", async () => {
    harness = await Harness.create();
    await harness.initialize();
    const sessionId = await harness.newSession();
    const before = harness.faux.state.callCount;
    const status = await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "/status" }] });
    expect(status.stopReason).toBe("end_turn");
    expect(harness.text(sessionId)).toContain("faux/faux-1");
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "/name Renamed" }] });
    await harness.settle();
    expect(
      harness
        .updatesFor(sessionId)
        .some((u) => u.sessionUpdate === "session_info_update" && u.title === "Renamed"),
    ).toBe(true);
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "/mode full-access" }] });
    expect(harness.faux.state.callCount).toBe(before);
    await harness.settle();
    expect(
      harness
        .updatesFor(sessionId)
        .some((u) => u.sessionUpdate === "current_mode_update" && u.currentModeId === "full-access"),
    ).toBe(true);
  });
});

describe("session lifecycle", () => {
  it("lists, loads with replay, resumes, forks, and deletes sessions", async () => {
    harness = await Harness.create({ settings: { permissionMode: "full-access" } });
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(fauxAssistantMessage("first answer"));
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "first question" }] });
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "/name Listed" }] });
    await harness.client.closeSession({ sessionId });

    const listed = await harness.client.listSessions({ cwd: harness.workspace });
    expect(listed.sessions.map((s) => s.sessionId)).toContain(sessionId);
    expect(listed.sessions.find((s) => s.sessionId === sessionId)).toMatchObject({
      title: "Listed",
      cwd: harness.workspace,
    });

    harness.notifications.length = 0;
    const loaded = await harness.client.loadSession({ sessionId, cwd: harness.workspace, mcpServers: [] });
    expect(loaded.modes).toMatchObject({ currentModeId: "full-access" });
    await harness.settle();
    const replay = harness.updatesFor(sessionId);
    expect(
      replay.some(
        (u) =>
          u.sessionUpdate === "user_message_chunk" &&
          u.content.type === "text" &&
          u.content.text === "first question",
      ),
    ).toBe(true);
    expect(harness.text(sessionId)).toContain("first answer");

    // Resume: no replay, but the session keeps working.
    harness.notifications.length = 0;
    await harness.client.resumeSession({ sessionId, cwd: harness.workspace, mcpServers: [] });
    await harness.settle();
    expect(harness.updatesFor(sessionId).some((u) => u.sessionUpdate === "user_message_chunk")).toBe(false);
    harness.respond(fauxAssistantMessage("second answer"));
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "second" }] });
    expect(harness.text(sessionId)).toContain("second answer");

    const forked = await harness.client.unstable_forkSession({ sessionId, cwd: harness.workspace });
    expect(forked.sessionId).not.toBe(sessionId);
    const listedAfterFork = await harness.client.listSessions({ cwd: harness.workspace });
    expect(listedAfterFork.sessions.map((s) => s.sessionId)).toContain(forked.sessionId);

    await harness.client.deleteSession({ sessionId });
    const afterDelete = await harness.client.listSessions({ cwd: harness.workspace });
    expect(afterDelete.sessions.map((s) => s.sessionId)).not.toContain(sessionId);
    await harness.client.deleteSession({ sessionId }); // idempotent
  });

  it("silently restores a session an agent restart forgot", async () => {
    harness = await Harness.create({ settings: { permissionMode: "full-access" } });
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(fauxAssistantMessage("a"));
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "q" }] });
    await harness.client.closeSession({ sessionId });
    harness.respond(fauxAssistantMessage("b"));
    const response = await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "again" }] });
    expect(response.stopReason).toBe("end_turn");
    expect(harness.text(sessionId)).toContain("b");
  });

  it("rejects unknown sessions and relative cwds", async () => {
    harness = await Harness.create();
    await harness.initialize();
    await expect(
      harness.client.prompt({ sessionId: "nope", prompt: [{ type: "text", text: "x" }] }),
    ).rejects.toThrow(/unknown session/);
    await expect(harness.client.newSession({ cwd: "relative", mcpServers: [] })).rejects.toThrow(/absolute/);
  });
});

describe("cancellation and steering", () => {
  it("cancels a running turn", async () => {
    harness = await Harness.create({ settings: { permissionMode: "full-access" } });
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 5; echo late" })]),
      fauxAssistantMessage("never"),
    );
    const promptPromise = harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "slow" }] });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await harness.client.cancel({ sessionId });
    const response = await promptPromise;
    expect(response.stopReason).toBe("cancelled");
  });

  it("reports promptRequired when idle and injects when running", async () => {
    harness = await Harness.create({ settings: { permissionMode: "full-access" } });
    await harness.initialize();
    const sessionId = await harness.newSession();
    const idle = await harness.client.extMethod("_session/steering", {
      sessionId,
      prompt: [{ type: "text", text: "x" }],
    });
    expect(idle).toEqual({ outcome: "promptRequired", reason: "noRunningTurn" });

    harness.respond(
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1; echo done" })]),
      fauxAssistantMessage("after tool"),
      fauxAssistantMessage("after steer"),
    );
    const promptPromise = harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const injected = await harness.client.extMethod("_session/steering", {
      sessionId,
      prompt: [{ type: "text", text: "also this" }],
    });
    expect(injected).toEqual({ outcome: "injected" });
    const response = await promptPromise;
    expect(response.stopReason).toBe("end_turn");
    expect(harness.faux.state.callCount).toBeGreaterThanOrEqual(2);
  });
});

describe("extension UI over ACP", () => {
  it("routes pi ui.select through form elicitation", async () => {
    harness = await Harness.create({
      clientCapabilities: { elicitation: { form: {} } },
      onElicitation: () => ({ action: "accept", content: { choice: "choice-1" } }),
    });
    await harness.initialize();
    const sessionId = await harness.newSession();
    const extensionDir = join(harness.workspace, ".pi", "extensions");
    // Extensions need project trust; write a global extension instead.
    void extensionDir;
    // Use the live pi session's UI context directly (same path extensions use).
    const live = harness.agent["sessions"].get(sessionId)!;
    const picked = await live.session.extensionRunner.getUIContext().select("Pick", ["a", "b"]);
    expect(picked).toBe("b");
    expect(harness.elicitations[0]).toMatchObject({ mode: "form", sessionId, message: "Pick" });
  });

  it("falls back to permission requests for select/confirm without elicitation", async () => {
    harness = await Harness.create({
      onPermission: (request) => ({
        outcome: { outcome: "selected", optionId: request.options[0]?.optionId ?? "" },
      }),
    });
    await harness.initialize();
    const sessionId = await harness.newSession();
    const live = harness.agent["sessions"].get(sessionId)!;
    const ui = live.session.extensionRunner.getUIContext();
    expect(await ui.select("Pick", ["first", "second"])).toBe("first");
    expect(await ui.confirm("Sure?", "really")).toBe(true);
    expect(await ui.input("Name")).toBeUndefined();
  });
});
