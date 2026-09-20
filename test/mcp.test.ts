import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, Harness } from "./helpers/harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("MCP servers", () => {
  it("mounts a stdio server's tools as mcp__<server>__<tool> and executes them", async () => {
    harness = await Harness.create({ settings: { permissionMode: "full-access" } });
    await harness.initialize();
    const fixture = join(import.meta.dirname, "fixtures", "mcp-echo-server.mjs");
    const created = await harness.client.newSession({
      cwd: harness.workspace,
      mcpServers: [{ name: "fixture server", command: process.execPath, args: [fixture], env: [] }],
    });
    const sessionId = created.sessionId;
    expect(created._meta).toMatchObject({ pi: { diagnostics: [] } });

    harness.respond(
      fauxAssistantMessage([fauxToolCall("mcp__fixture_server__echo", { text: "hi" })]),
      fauxAssistantMessage("done"),
    );
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "use the tool" }] });
    const call = harness.updatesFor(sessionId).find((u) => u.sessionUpdate === "tool_call");
    expect(call).toMatchObject({ name: "mcp__fixture_server__echo", title: "fixture_server: echo" });
    const done = harness
      .updatesFor(sessionId)
      .find((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed");
    expect(JSON.stringify(done)).toContain("echo: hi");
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "/tools" }] });
    expect(harness.text(sessionId)).toContain("[x] mcp__fixture_server__echo");
  });

  it("keeps the session alive when a server fails to start", async () => {
    harness = await Harness.create();
    await harness.initialize();
    const created = await harness.client.newSession({
      cwd: harness.workspace,
      mcpServers: [{ name: "broken", command: "/nonexistent/binary", args: [], env: [] }],
    });
    const meta = created._meta as { pi: { diagnostics: string[] } };
    expect(meta.pi.diagnostics[0]).toMatch(/MCP server "broken" unavailable/);
  });
});
