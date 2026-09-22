/** Mount client-supplied ACP MCP servers as native Pi custom tools. */
import type { McpServer } from "@agentclientprotocol/sdk";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type, type TSchema } from "typebox";
import { errorMessage, logDebug, logWarn } from "../log.ts";
import { VERSION } from "../version.ts";

export interface McpMount {
  name: string;
  tools: ToolDefinition[];
  close(): Promise<void>;
}

export interface McpMountResult {
  mounts: McpMount[];
  tools: ToolDefinition[];
  diagnostics: string[];
}

function identifier(raw: string, fallback: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "_") || fallback;
}

export function sanitizeServerName(raw: string): string {
  return identifier(raw, "server").slice(0, 32);
}

/** Provider tool identifiers have a stricter alphabet and length than MCP names. */
export function mcpToolName(server: string, tool: string): string {
  const prefix = `mcp__${sanitizeServerName(server)}__`;
  return prefix + identifier(tool, "tool").slice(0, 64 - prefix.length);
}

function uniqueName(base: string, taken: Set<string>, limit: number): string {
  let name = base;
  for (let index = 2; taken.has(name); index += 1) {
    const suffix = `_${index}`;
    name = base.slice(0, limit - suffix.length) + suffix;
  }
  taken.add(name);
  return name;
}

function parameters(schema: Tool["inputSchema"]): TSchema {
  return Type.Unsafe({ ...schema, properties: schema.properties ?? {} });
}

type Content = Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

function contentFromMcp(content: unknown): Content {
  if (!Array.isArray(content)) return [];
  return content.map((block: Record<string, unknown>): Content[number] => {
    if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      return { type: "image", data: block.data, mimeType: block.mimeType };
    }
    if (block.type === "resource" && typeof block.resource === "object" && block.resource !== null) {
      const resource = block.resource as Record<string, unknown>;
      if (typeof resource.text === "string") return { type: "text", text: resource.text };
    }
    // Pi supports text and images; retain other MCP content without silently dropping it.
    return { type: "text", text: JSON.stringify(block) };
  });
}

function transportFor(server: McpServer, cwd: string) {
  if ("command" in server) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    for (const entry of server.env) env[entry.name] = entry.value;
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env,
      cwd,
      stderr: "pipe",
    });
    // Drain stderr without forwarding untrusted server output (which may contain credentials).
    transport.stderr?.on("data", () => {});
    return transport;
  }
  if (server.type === "http") {
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) },
    });
  }
  throw new Error("unsupported MCP transport (stdio and streamable HTTP are supported)");
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor });
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error("tools/list repeated a pagination cursor");
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  return tools;
}

async function mountOne(server: McpServer, cwd: string, name: string): Promise<McpMount> {
  const transport = transportFor(server, cwd);
  const client = new Client({ name: "openma-pi-acp", version: VERSION });
  const close = async () => {
    try {
      await client.close();
    } catch {
      logDebug(`MCP server "${name}" cleanup failed`);
    }
  };
  try {
    await client.connect(transport);
    const declared = await listAllTools(client);
    const taken = new Set<string>();
    const tools = declared.map((tool): ToolDefinition => ({
      name: uniqueName(mcpToolName(name, tool.name), taken, 64),
      label: `${name}: ${tool.name}`,
      description: tool.description ?? `${tool.name} (MCP server ${name})`,
      parameters: parameters(tool.inputSchema),
      promptSnippet: tool.description?.split("\n", 1)[0] ?? tool.name,
      execute: async (_toolCallId, args, signal) => {
        signal?.throwIfAborted();
        const result = await client.callTool(
          { name: tool.name, arguments: (args ?? {}) as Record<string, unknown> },
          undefined,
          { signal },
        );
        signal?.throwIfAborted();
        const content = contentFromMcp(result.content);
        if (content.length === 0 && result.structuredContent !== undefined) {
          content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
        }
        if (result.isError === true) {
          throw new Error(
            content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n") || `MCP tool ${tool.name} failed`,
          );
        }
        return {
          content: content.length ? content : [{ type: "text", text: "(no output)" }],
          details: { server: name, tool: tool.name, structuredContent: result.structuredContent },
        };
      },
    }));
    logDebug(`mounted MCP server "${name}" with ${tools.length} tool(s)`);
    return { name, tools, close };
  } catch (error) {
    // Discovery can fail after initialization succeeded; that connection still belongs to us.
    await close();
    throw error;
  }
}

export async function mountMcpServers(
  servers: readonly McpServer[] | undefined,
  cwd: string,
): Promise<McpMountResult> {
  const taken = new Set<string>();
  const results = await Promise.all(
    (servers ?? []).map(async (server) => {
      const name = uniqueName(sanitizeServerName(server.name), taken, 32);
      try {
        return { mount: await mountOne(server, cwd, name) };
      } catch (error) {
        const diagnostic = `MCP server "${name}" unavailable: ${errorMessage(error)}`;
        logWarn(diagnostic);
        return { diagnostic };
      }
    }),
  );
  const mounts = results.flatMap((result) => (result.mount ? [result.mount] : []));
  const toolNames = new Set<string>();
  for (const mount of mounts) {
    for (const tool of mount.tools) tool.name = uniqueName(tool.name, toolNames, 64);
  }
  return {
    mounts,
    tools: mounts.flatMap((mount) => mount.tools),
    diagnostics: results.flatMap((result) => (result.diagnostic ? [result.diagnostic] : [])),
  };
}
