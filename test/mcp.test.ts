import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountMcpServers, type McpMountResult } from "../src/acp/mcp.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function endpoint(
  options: {
    list?: (cursor?: string) => ListToolsResult | Promise<ListToolsResult>;
    call?: (params: CallToolRequest["params"]) => CallToolResult | Promise<CallToolResult>;
    json?: boolean;
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
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { method: string };
    requests.push({ method: body.method, authorization: req.headers.authorization });
    if (req.headers.authorization !== "Bearer test-project-token") {
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
            { name: "project.delegate", description: "Delegate a task", inputSchema: { type: "object" } },
          ],
        },
    );
    server.setRequestHandler(
      CallToolRequestSchema,
      ({ params }) => options.call?.(params) ?? { content: [{ type: "text", text: "accepted" }] },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: options.json ?? true,
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
    headers: [{ name: "Authorization", value: "Bearer test-project-token" }],
  };
  return { descriptor, requests };
}

async function mount(descriptors: McpServer[]): Promise<McpMountResult> {
  const result = await mountMcpServers(descriptors, process.cwd());
  cleanups.push(async () => {
    await Promise.all(result.mounts.map((entry) => entry.close()));
  });
  return result;
}

function execute(tool: ToolDefinition, args: Record<string, unknown> = {}, signal?: AbortSignal) {
  return tool.execute("call-1", args, signal, undefined, {} as ExtensionContext);
}

describe("ACP MCP tools", () => {
  it.each([true, false])(
    "mounts authenticated HTTP tools and preserves the delegation receipt (JSON=%s)",
    async (json) => {
      const calls: CallToolRequest["params"][] = [];
      const remote = await endpoint({
        json,
        call: (params) => {
          calls.push(params);
          return {
            content: [{ type: "text", text: "Worker started" }],
            structuredContent: { workerId: "worker-7", accepted: true },
          };
        },
      });
      const result = await mount([remote.descriptor]);
      expect(result.diagnostics).toEqual([]);
      expect(result.tools.map((tool) => tool.name)).toEqual(["mcp__Project__project_delegate"]);
      const output = await execute(result.tools[0]!, { task: "review" });
      expect(calls).toEqual([{ name: "project.delegate", arguments: { task: "review" } }]);
      expect(output.content).toEqual([{ type: "text", text: "Worker started" }]);
      expect(output.details).toMatchObject({
        tool: "project.delegate",
        structuredContent: { workerId: "worker-7", accepted: true },
      });
      expect(remote.requests.map((request) => request.method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
      ]);
      expect(remote.requests.every((request) => request.authorization === "Bearer test-project-token")).toBe(
        true,
      );
    },
  );

  it("includes every tools/list page with unique provider-safe names", async () => {
    const cursors: Array<string | undefined> = [];
    const calls: string[] = [];
    const names = ["project.delegate", "project_delegate", "x".repeat(100), "x".repeat(99) + "y"];
    const remote = await endpoint({
      list: (cursor) => {
        cursors.push(cursor);
        return {
          tools: (cursor ? names.slice(1) : names.slice(0, 1)).map((name) => ({
            name,
            inputSchema: { type: "object" as const },
          })),
          ...(cursor ? {} : { nextCursor: "next" }),
        };
      },
      call: (params) => {
        calls.push(params.name);
        return { content: [] };
      },
    });
    remote.descriptor.name = "My.Project";
    const result = await mount([remote.descriptor]);
    expect(cursors).toEqual([undefined, "next"]);
    expect(result.tools).toHaveLength(4);
    expect(new Set(result.tools.map((tool) => tool.name)).size).toBe(4);
    for (const tool of result.tools) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      await execute(tool);
    }
    expect(calls).toEqual(names);
  });

  it("makes structured-only results visible to Pi and propagates MCP tool errors", async () => {
    const remote = await endpoint({
      call: ({ arguments: args }) =>
        args?.fail
          ? { isError: true, content: [{ type: "text", text: "Worker quota exceeded" }] }
          : { content: [], structuredContent: { workerId: "worker-8" } },
    });
    const { tools } = await mount([remote.descriptor]);
    const result = await execute(tools[0]!);
    expect(result.content).toEqual([{ type: "text", text: '{"workerId":"worker-8"}' }]);
    await expect(execute(tools[0]!, { fail: true })).rejects.toThrow("Worker quota exceeded");
  });

  it("keeps names unique across ambiguous server and tool namespaces", async () => {
    const first = await endpoint({
      list: () => ({ tools: [{ name: "B__C", inputSchema: { type: "object" } }] }),
    });
    const second = await endpoint({
      list: () => ({ tools: [{ name: "C", inputSchema: { type: "object" } }] }),
    });
    first.descriptor.name = "A";
    second.descriptor.name = "A__B";
    const result = await mount([first.descriptor, second.descriptor]);
    expect(result.tools.map((tool) => tool.name)).toEqual(["mcp__A__B__C", "mcp__A__B__C_2"]);
  });

  it("aborts an in-flight tool call rather than accepting its late result", async () => {
    let acknowledge!: () => void;
    const entered = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    let finish!: (result: CallToolResult) => void;
    const remote = await endpoint({
      call: () => {
        acknowledge();
        return new Promise<CallToolResult>((resolve) => {
          finish = resolve;
        });
      },
    });
    const { tools } = await mount([remote.descriptor]);
    const controller = new AbortController();
    const result = execute(tools[0]!, {}, controller.signal);
    const rejected = expect(result).rejects.toThrow(/abort|cancel/i);
    await entered;
    controller.abort(new Error("cancelled by user"));
    await rejected;
    finish({ content: [{ type: "text", text: "late success" }] });
  });

  it("closes a connection whose tool discovery fails while keeping healthy servers", async () => {
    const close = vi.spyOn(Client.prototype, "close");
    const broken = await endpoint({
      list: () => {
        throw new Error("discovery failed");
      },
    });
    const healthy = await endpoint();
    const result = await mount([broken.descriptor, healthy.descriptor]);
    expect(result.mounts).toHaveLength(1);
    expect(result.tools).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toContain("discovery failed");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects a repeated pagination cursor instead of looping forever", async () => {
    const remote = await endpoint({ list: () => ({ tools: [], nextCursor: "same" }) });
    const result = await mount([remote.descriptor]);
    expect(result.tools).toEqual([]);
    expect(result.diagnostics[0]).toMatch(/cursor|pagination/i);
    expect(remote.requests.filter((request) => request.method === "tools/list")).toHaveLength(2);
  });

  it.each([false, true])(
    "releases the real stdio child after close or failed discovery (failure=%s)",
    async (failList) => {
      const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-acp-mcp-")));
      cleanups.push(() => rm(cwd, { recursive: true, force: true }));
      const script = `
      import { writeFileSync } from "node:fs";
      import { Server } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))};
      import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
      import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))};
      writeFileSync("pid", String(process.pid));
      const server = new Server({ name: "stdio-test", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, () => {
        if (${failList}) throw new Error("stdio discovery failed");
        return { tools: [{ name: "workspace.info", inputSchema: { type: "object" } }] };
      });
      server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: "text", text: JSON.stringify({ cwd: process.cwd(), flag: process.env.MCP_TEST_FLAG }) }] }));
      await server.connect(new StdioServerTransport());
    `;
      const result = await mountMcpServers(
        [
          {
            name: "Local MCP",
            command: process.execPath,
            args: ["--input-type=module", "-e", script],
            env: [{ name: "MCP_TEST_FLAG", value: "descriptor-value" }],
          },
        ],
        cwd,
      );
      cleanups.push(async () => {
        await Promise.all(result.mounts.map((entry) => entry.close()));
      });
      const pid = Number(await readFile(join(cwd, "pid"), "utf8"));
      if (failList) {
        expect(result.tools).toEqual([]);
        expect(result.diagnostics[0]).toContain("stdio discovery failed");
      } else {
        expect(result.diagnostics).toEqual([]);
        const output = await execute(result.tools[0]!);
        expect(output.content).toEqual([
          { type: "text", text: JSON.stringify({ cwd, flag: "descriptor-value" }) },
        ]);
        await result.mounts[0]!.close();
      }
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );
});
