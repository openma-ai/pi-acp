import { afterEach, expect, it, vi } from "vitest";
import { Harness, fauxAssistantMessage } from "./helpers/harness.ts";
import { PiAcpSession } from "../src/acp/session.ts";
let h: Harness | undefined;
const opened: PiAcpSession[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(opened.splice(0).map((s) => s.close()));
  await h?.close();
  h = undefined;
});
async function savedSession() {
  h = await Harness.create();
  await h.initialize();
  const id = await h.newSession();
  for (let i = 0; i < 12; i++) {
    h.respond(fauxAssistantMessage(`answer-${i}`));
    await h.client.prompt({ sessionId: id, prompt: [{ type: "text", text: `question-${i}` }] });
  }
  await h.settle();
  return id;
}
it("finishes history delivery before acknowledging load", async () => {
  const id = await savedSession();
  h!.notifications.length = 0;
  await h!.client.loadSession({ sessionId: id, cwd: h!.workspace, mcpServers: [] });
  expect(
    h!.notifications.filter((n) =>
      ["user_message_chunk", "agent_message_chunk"].includes(n.update.sessionUpdate),
    ),
  ).toHaveLength(24);
});
it("cleans every runtime opened by concurrent resumes", async () => {
  const id = await savedSession();
  const original = PiAcpSession.open;
  const cleanups: ReturnType<typeof vi.spyOn>[] = [];
  vi.spyOn(PiAcpSession, "open").mockImplementation(async (options) => {
    const s = await original(options);
    opened.push(s);
    cleanups.push(vi.spyOn(s, "close"));
    return s;
  });
  await Promise.allSettled([
    h!.client.resumeSession({ sessionId: id, cwd: h!.workspace, mcpServers: [] }),
    h!.client.resumeSession({ sessionId: id, cwd: h!.workspace, mcpServers: [] }),
  ]);
  await h!.agent.dispose();
  expect(cleanups.length).toBeGreaterThan(0);
  for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalled();
});
async function captureSession() {
  const original = PiAcpSession.open;
  let captured: PiAcpSession | undefined;
  vi.spyOn(PiAcpSession, "open").mockImplementation(async (options) => {
    const s = await original(options);
    opened.push(s);
    captured = s;
    return s;
  });
  const id = await savedSession();
  return { session: captured!, id };
}
it("reports delivery failure instead of acknowledging a successful flush", async () => {
  const { session } = await captureSession();
  vi.spyOn(session.conn, "sessionUpdate").mockRejectedValue(new Error("broken wire"));
  session.text("must reach the client");
  await expect(session.flush()).rejects.toThrow("broken wire");
});
it("keeps the turn active until its final updates drain", async () => {
  const { session, id } = await captureSession();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = session.conn.sessionUpdate.bind(session.conn);
  vi.spyOn(session.conn, "sessionUpdate").mockImplementation(async (params) => {
    await gate;
    return original(params);
  });
  let settled!: () => void;
  const done = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const unsubscribe = session.session.subscribe((event) => {
    if (event.type === "agent_settled") settled();
  });
  h!.respond(fauxAssistantMessage("finish"));
  const prompt = h!.client.prompt({ sessionId: id, prompt: [{ type: "text", text: "go" }] });
  try {
    await done;
    expect(session.isRunning).toBe(true);
  } finally {
    release();
    unsubscribe();
    await prompt;
  }
});
it("retries model initialization after a transient failure", async () => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const { PiAcpAgent } = await import("../src/acp/agent.ts");
  const { resolveSettings } = await import("../src/settings.ts");
  h = await Harness.create();
  vi.spyOn(ModelRuntime, "create")
    .mockRejectedValueOnce(new Error("temporary initialization failure"))
    .mockResolvedValue(h.modelRuntime);
  const conn = {
    extNotification: async () => {},
    sessionUpdate: async () => {},
  } as unknown as ConstructorParameters<typeof PiAcpAgent>[0];
  const agent = new PiAcpAgent(conn, {
    settings: {
      ...resolveSettings([]),
      agentDir: h.agentDir,
      sessionDir: h.sessionDir,
      model: "faux/faux-1",
      quietStartup: true,
    },
  });
  try {
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await expect(agent.newSession({ cwd: h.workspace, mcpServers: [] })).resolves.toHaveProperty("sessionId");
  } finally {
    await agent.dispose();
  }
});
it("a close during resume prevents the late runtime from becoming active", async () => {
  const id = await savedSession();
  const original = PiAcpSession.open;
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const opening = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let cleanup: ReturnType<typeof vi.spyOn> | undefined;
  vi.spyOn(PiAcpSession, "open").mockImplementation(async (options) => {
    const s = await original(options);
    opened.push(s);
    cleanup = vi.spyOn(s, "close");
    reached();
    await gate;
    return s;
  });
  const resume = h!.client.resumeSession({ sessionId: id, cwd: h!.workspace, mcpServers: [] });
  const outcome = expect(resume).rejects.toThrow(/superseded|closed/);
  await opening;
  await h!.client.closeSession({ sessionId: id });
  release();
  await outcome;
  expect(cleanup).toHaveBeenCalled();
});
it("disposes runtime resources even when notification delivery fails", async () => {
  const { session } = await captureSession();
  const cleanup = vi.spyOn(session.session, "abort");
  vi.spyOn(session.conn, "sessionUpdate").mockRejectedValue(new Error("broken wire"));
  session.text("lost");
  await expect(session.flush()).rejects.toThrow("broken wire");
  await expect(session.close()).resolves.toBeUndefined();
  expect(cleanup).toHaveBeenCalled();
  await expect(session.prompt("after close", undefined)).rejects.toThrow(/closed/);
});
