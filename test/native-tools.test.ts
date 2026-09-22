import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { Harness, fauxAssistantMessage, fauxToolCall } from "./helpers/harness.ts";

it("runs pi write and bash tools without adapter approval", async () => {
  const h = await Harness.create({
    onPermission: () => ({ outcome: { outcome: "selected", optionId: "reject-once" } }),
  });
  try {
    await h.initialize();
    const id = await h.newSession();
    h.respond(
      fauxAssistantMessage([fauxToolCall("write", { path: "native.txt", content: "native" })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "printf shell > shell.txt" })]),
      fauxAssistantMessage("done"),
    );
    await h.client.prompt({ sessionId: id, prompt: [{ type: "text", text: "run" }] });
    expect(h.permissionRequests).toHaveLength(0);
    expect(readFileSync(join(h.workspace, "native.txt"), "utf8")).toBe("native");
    expect(readFileSync(join(h.workspace, "shell.txt"), "utf8")).toBe("shell");
  } finally {
    await h.close();
  }
});

it("exposes thinking but no adapter permission mode", async () => {
  const h = await Harness.create();
  try {
    await h.initialize();
    const session = await h.client.newSession({ cwd: h.workspace, mcpServers: [] });
    expect(session.modes).toBeUndefined();
    expect(session.configOptions?.map((o) => o.id)).not.toContain("mode");
    expect(session.configOptions?.map((o) => o.id)).toContain("thinking");
    await expect(
      h.client.setSessionConfigOption({ sessionId: session.sessionId, configId: "mode", value: "read-only" }),
    ).rejects.toThrow();
    await expect(
      h.client.setSessionMode({ sessionId: session.sessionId, modeId: "read-only" }),
    ).rejects.toThrow();
    await h.settle();
    const commands = h
      .updatesFor(session.sessionId)
      .find((u) => u.sessionUpdate === "available_commands_update");
    expect(
      commands?.sessionUpdate === "available_commands_update" &&
        commands.availableCommands.some((c) => c.name === "mode"),
    ).toBe(false);
  } finally {
    await h.close();
  }
});

it("injects MCP tools through ACP and remounts the caller's current servers on load and resume", async () => {
  const calls: { authorization: string | undefined; params: unknown }[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (message.method === "initialize")
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "Project", version: "1" },
      };
    else if (message.method === "tools/list")
      result = {
        tools: [
          {
            name: "project.delegate",
            description: "Delegate a task",
            inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
          },
        ],
      };
    else if (message.method === "tools/call") {
      calls.push({ authorization: req.headers.authorization, params: message.params });
      result = {
        content: [{ type: "text", text: "accepted-real-mcp" }],
        structuredContent: { status: "accepted" },
      };
    } else {
      res.writeHead(400).end();
      return;
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  const descriptor = (token: string) => ({
    name: "Project",
    type: "http" as const,
    url: `http://127.0.0.1:${address.port}`,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
  });
  const h = await Harness.create();
  try {
    const init = await h.initialize();
    expect(init.agentCapabilities?.mcpCapabilities?.http).toBe(true);
    const created = await h.client.newSession({ cwd: h.workspace, mcpServers: [descriptor("first")] });
    const sessionId = created.sessionId;
    const prompt = async (task: string) => {
      h.respond(
        fauxAssistantMessage([fauxToolCall("mcp__Project__project_delegate", { task })]),
        fauxAssistantMessage("done"),
      );
      expect(await h.client.prompt({ sessionId, prompt: [{ type: "text", text: task }] })).toMatchObject({
        stopReason: "end_turn",
      });
    };
    await prompt("initial");
    await h.client.loadSession({ sessionId, cwd: h.workspace, mcpServers: [descriptor("loaded")] });
    await prompt("loaded");
    await h.client.resumeSession({ sessionId, cwd: h.workspace, mcpServers: [descriptor("resumed")] });
    await prompt("resumed");
    expect(calls).toEqual(
      ["initial", "loaded", "resumed"].map((task, index) => ({
        authorization: `Bearer ${["first", "loaded", "resumed"][index]}`,
        params: { name: "project.delegate", arguments: { task } },
      })),
    );
    expect(
      h
        .updatesFor(sessionId)
        .some(
          (u) =>
            u.sessionUpdate === "tool_call_update" &&
            u.status === "completed" &&
            JSON.stringify(u).includes("accepted-real-mcp"),
        ),
    ).toBe(true);
    await h.client.resumeSession({ sessionId, cwd: h.workspace, mcpServers: [] });
    const previousTextLength = h.text(sessionId).length;
    await h.client.prompt({ sessionId, prompt: [{ type: "text", text: "/tools" }] });
    expect(h.text(sessionId).slice(previousTextLength)).not.toContain("mcp__Project__project_delegate");
    // An empty descriptor list must not resurrect a previous session's tools.
    const empty = await h.client.newSession({ cwd: h.workspace, mcpServers: [] });
    await h.client.prompt({ sessionId: empty.sessionId, prompt: [{ type: "text", text: "/tools" }] });
    expect(h.text(empty.sessionId)).not.toContain("mcp__Project__project_delegate");
  } finally {
    await h.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
