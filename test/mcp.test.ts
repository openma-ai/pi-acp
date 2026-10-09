import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { literalConfigValue, planAcpMcpServers } from "../src/acp/mcp.ts";
import { fauxAssistantMessage, fauxToolCall, Harness } from "./helpers/harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("ACP MCP server plan", () => {
  it("keeps header and env values literal and asks pi for deferred tools", () => {
    expect(literalConfigValue("Bearer $literal")).toBe("Bearer $$literal");
    expect(literalConfigValue("!echo secret")).toBe("$!echo secret");
    const plan = planAcpMcpServers([
      {
        type: "http",
        name: "My.Project",
        url: "http://127.0.0.1:9/mcp",
        headers: [{ name: "Authorization", value: "Bearer $literal" }],
      },
      {
        name: "Local MCP",
        command: "node",
        args: ["server.js"],
        env: [{ name: "MCP_TEST_FLAG", value: "descriptor-value" }],
      },
    ]);
    expect(plan.diagnostics).toEqual([]);
    expect(plan.servers.map((server) => server.name)).toEqual(["My_Project", "Local_MCP"]);
    expect(plan.servers[0]?.config).toMatchObject({
      exposure: "deferred",
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer $$literal" },
    });
    expect(plan.servers[1]?.config).toMatchObject({
      exposure: "deferred",
      command: "node",
      args: ["server.js"],
      env: { MCP_TEST_FLAG: "descriptor-value" },
    });
  });

  it("rejects legacy SSE and names that share a pi namespace", () => {
    const sse = planAcpMcpServers([{ type: "sse", name: "Old", url: "http://127.0.0.1:9/sse", headers: [] }]);
    expect(sse.servers).toEqual([]);
    expect(sse.diagnostics[0]).toMatch(/SSE/);

    const clash = planAcpMcpServers([
      { name: "a-b", command: "node", args: [], env: [] },
      { name: "a_b", command: "node", args: [], env: [] },
    ]);
    expect(clash.diagnostics).toEqual([]);
    expect(clash.servers.map((server) => server.name)).toEqual(["a-b", "a_b_2"]);

    const bad = planAcpMcpServers([{ type: "http", name: "Broken", url: "not a url", headers: [] }]);
    expect(bad.servers).toEqual([]);
    expect(bad.diagnostics[0]).toMatch(/url/);
  });
});

async function endpoint(
  options: {
    list?: (cursor?: string) => ListToolsResult | Promise<ListToolsResult>;
    call?: (params: CallToolRequest["params"]) => CallToolResult | Promise<CallToolResult>;
  } = {},
) {
  const requests: Array<{ method: string; authorization?: string }> = [];
  const servers = new Set<Server>();
  const http = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { method?: string };
    requests.push({
      method: body.method ?? "",
      authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
    });
    if (req.headers.authorization !== "Bearer $literal") {
      res.writeHead(403).end();
      return;
    }
    const server = new Server({ name: "project-test", version: "1" }, { capabilities: { tools: {} } });
    servers.add(server);
    server.setRequestHandler(
      ListToolsRequestSchema,
      ({ params }) =>
        options.list?.(params?.cursor) ?? {
          tools: [
            {
              name: "project.delegate",
              description: "Delegate a task",
              inputSchema: { type: "object", properties: { task: { type: "string" } } },
            },
          ],
        },
    );
    server.setRequestHandler(
      CallToolRequestSchema,
      ({ params }) =>
        options.call?.(params) ?? {
          content: [{ type: "text", text: "accepted" }],
        },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void server.close();
      servers.delete(server);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await Promise.all([...servers].map((server) => server.close()));
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
  });
  const descriptor: McpServer = {
    type: "http",
    name: "Project",
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
    headers: [{ name: "Authorization", value: "Bearer $literal" }],
  };
  return { descriptor, requests };
}

function toolCalls(updates: ReturnType<Harness["updatesFor"]>) {
  return updates.filter((update) => update.sessionUpdate === "tool_call");
}

describe("ACP session MCP calls", () => {
  it("searches a deferred HTTP tool and projects the call", async () => {
    const calls: CallToolRequest["params"][] = [];
    const remote = await endpoint({
      call: (params) => {
        calls.push(params);
        if (params.arguments?.fail === true) {
          return { isError: true, content: [{ type: "text", text: "Worker quota exceeded" }] };
        }
        return {
          content: [
            { type: "text", text: "Worker started" },
            { type: "image", data: "AQID", mimeType: "image/png" },
            { type: "resource", resource: { uri: "file:///note.txt", text: "from-resource" } },
          ],
          structuredContent: { workerId: "worker-7", accepted: true },
        };
      },
    });
    const harness = await Harness.create();
    cleanups.push(() => harness.close());
    await harness.initialize();
    const created = await harness.client.newSession({
      cwd: harness.workspace,
      mcpServers: [remote.descriptor],
    });
    const sessionId = created.sessionId;

    harness.respond(
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "delegate task" })]),
      fauxAssistantMessage([fauxToolCall("mcp__Project__project_delegate", { task: "review" })]),
      fauxAssistantMessage("done"),
    );
    expect(
      await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "delegate" }] }),
    ).toMatchObject({
      stopReason: "end_turn",
    });

    expect(calls.map(({ name, arguments: args }) => ({ name, arguments: args }))).toEqual([
      { name: "project.delegate", arguments: { task: "review" } },
    ]);
    expect(remote.requests.some((request) => request.method === "tools/list")).toBe(true);
    expect(
      remote.requests
        .filter((request) => request.method === "tools/call")
        .every((request) => request.authorization === "Bearer $literal"),
    ).toBe(true);
    const updates = harness.updatesFor(sessionId);
    expect(toolCalls(updates).map((update) => update.name)).toEqual([
      "tool_search",
      "mcp__Project__project_delegate",
    ]);
    expect(toolCalls(updates)[1]).toMatchObject({
      kind: "other",
      title: "Project: project_delegate",
      rawInput: { task: "review" },
    });
    const completed = updates.find(
      (update) =>
        update.sessionUpdate === "tool_call_update" &&
        update.status === "completed" &&
        JSON.stringify(update.rawOutput).includes("Worker started"),
    );
    const rendered = JSON.stringify(completed);
    expect(rendered).toContain("Worker started");
    expect(rendered).toContain("from-resource");
    expect(rendered).toContain("worker-7");
    expect(completed).toMatchObject({
      content: expect.arrayContaining([
        { type: "content", content: { type: "image", data: "AQID", mimeType: "image/png" } },
      ]),
    });

    harness.respond(
      fauxAssistantMessage([fauxToolCall("mcp__Project__project_delegate", { task: "again", fail: true })]),
      fauxAssistantMessage("done"),
    );
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "fail" }] });
    expect(
      harness
        .updatesFor(sessionId)
        .some(
          (update) =>
            update.sessionUpdate === "tool_call_update" &&
            update.status === "failed" &&
            JSON.stringify(update).includes("Worker quota exceeded"),
        ),
    ).toBe(true);
  }, 30_000);

  it("loads a tool that was listed on a later page", async () => {
    const names: string[] = [];
    const remote = await endpoint({
      list: (cursor) =>
        cursor
          ? {
              tools: [
                { name: "beta.two", description: "beta unique marker", inputSchema: { type: "object" } },
              ],
            }
          : {
              tools: [{ name: "alpha.one", description: "alpha", inputSchema: { type: "object" } }],
              nextCursor: "next",
            },
      call: (params) => {
        names.push(params.name);
        return { content: [{ type: "text", text: "paged" }] };
      },
    });
    const harness = await Harness.create();
    cleanups.push(() => harness.close());
    await harness.initialize();
    const sessionId = await harness.client
      .newSession({ cwd: harness.workspace, mcpServers: [remote.descriptor] })
      .then((created) => created.sessionId);
    harness.respond(
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "beta unique marker" })]),
      fauxAssistantMessage([fauxToolCall("mcp__Project__beta_two", {})]),
      fauxAssistantMessage("done"),
    );
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "beta" }] });
    expect(names).toEqual(["beta.two"]);
  }, 30_000);

  it("runs a stdio server in the session cwd and stops it on close", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-acp-mcp-")));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const script = `
      import { writeFileSync } from "node:fs";
      import { Server } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))};
      import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
      import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))};
      writeFileSync("pid", String(process.pid));
      const server = new Server({ name: "stdio-test", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "workspace.info", description: "Report cwd and flag", inputSchema: { type: "object" } }] }));
      server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: "text", text: JSON.stringify({ cwd: process.cwd(), flag: process.env.MCP_TEST_FLAG }) }] }));
      await server.connect(new StdioServerTransport());
    `;
    const harness = await Harness.create();
    cleanups.push(() => harness.close());
    await harness.initialize();
    const created = await harness.client.newSession({
      cwd,
      mcpServers: [
        {
          name: "Local MCP",
          command: process.execPath,
          args: ["--input-type=module", "-e", script],
          env: [{ name: "MCP_TEST_FLAG", value: "descriptor-value" }],
        },
      ],
    });
    harness.respond(
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "workspace cwd flag" })]),
      fauxAssistantMessage([fauxToolCall("mcp__Local_MCP__workspace_info", {})]),
      fauxAssistantMessage("done"),
    );
    await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "workspace" }],
    });
    const rendered = JSON.stringify(harness.updatesFor(created.sessionId));
    expect(rendered).toContain(cwd);
    expect(rendered).toContain("descriptor-value");
    const pid = Number(await readFile(join(cwd, "pid"), "utf8"));
    await harness.close();
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);
});
