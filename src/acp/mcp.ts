/**
 * ACP `mcpServers` → pi custom tools.
 *
 * Each server declared by the client is connected with the official MCP client
 * (stdio + streamable HTTP; SSE is legacy and refused at capability time). Its
 * tools are registered on the pi session as `mcp__<server>__<tool>`. A failing
 * server never takes the session down — it is logged and skipped.
 */

import type { McpServer } from "@agentclientprotocol/sdk";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type, type TSchema } from "typebox";
import { logDebug, logWarn, errorMessage } from "../log.ts";
import { VERSION } from "../version.ts";

export interface McpMount {
  name: string;
  tools: ToolDefinition[];
  close(): Promise<void>;
}

export interface McpMountResult {
  mounts: McpMount[];
  tools: ToolDefinition[];
  /** Human-readable problems (server skipped or failed). */
  diagnostics: string[];
}

/** mcp tool names must be safe identifiers; ACP server names are free-form. */
export function sanitizeServerName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  return cleaned.length > 0 ? cleaned : "server";
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

type JsonSchema = Record<string, unknown>;

/** MCP tool input schemas are plain JSON Schema; TypeBox accepts them via `Type.Unsafe`. */
function schemaFromMcp(inputSchema: unknown): TSchema {
  const schema: JsonSchema =
    inputSchema !== null && typeof inputSchema === "object"
      ? { ...(inputSchema as JsonSchema) }
      : { type: "object", properties: {} };
  if (schema["type"] === undefined) schema["type"] = "object";
  if (schema["type"] === "object" && schema["properties"] === undefined) schema["properties"] = {};
  return Type.Unsafe(schema);
}

interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { text?: string; uri?: string; mimeType?: string };
}

function contentFromMcp(
  content: unknown,
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  for (const raw of content as McpContentBlock[]) {
    if (raw.type === "text" && typeof raw.text === "string") out.push({ type: "text", text: raw.text });
    else if (raw.type === "image" && typeof raw.data === "string" && typeof raw.mimeType === "string") {
      out.push({ type: "image", data: raw.data, mimeType: raw.mimeType });
    } else if (raw.type === "resource" && raw.resource !== undefined) {
      const text = raw.resource.text;
      out.push({
        type: "text",
        text:
          typeof text === "string"
            ? text
            : `[resource ${raw.resource.uri ?? ""} ${raw.resource.mimeType ?? ""}]`,
      });
    } else out.push({ type: "text", text: JSON.stringify(raw) });
  }
  return out;
}

function transportFor(
  server: McpServer,
  cwd: string,
): StdioClientTransport | StreamableHTTPClientTransport | undefined {
  const record = server as unknown as Record<string, unknown>;
  if (typeof record["command"] === "string") {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
    const declared = Array.isArray(record["env"]) ? (record["env"] as { name: string; value: string }[]) : [];
    for (const entry of declared) env[entry.name] = entry.value;
    return new StdioClientTransport({
      command: record["command"],
      args: Array.isArray(record["args"]) ? (record["args"] as string[]) : [],
      env,
      cwd: typeof record["cwd"] === "string" ? record["cwd"] : cwd,
      stderr: "pipe",
    });
  }
  if (record["type"] === "http" && typeof record["url"] === "string") {
    const headers: Record<string, string> = {};
    const declared = Array.isArray(record["headers"])
      ? (record["headers"] as { name: string; value: string }[])
      : [];
    for (const entry of declared) headers[entry.name] = entry.value;
    return new StreamableHTTPClientTransport(new URL(record["url"]), {
      requestInit: { headers },
    });
  }
  return undefined;
}

async function mountOne(server: McpServer, cwd: string, serverName: string): Promise<McpMount> {
  const transport = transportFor(server, cwd);
  if (transport === undefined) {
    throw new Error(
      `unsupported MCP transport for "${serverName}" (stdio and streamable HTTP are supported)`,
    );
  }
  if (transport instanceof StdioClientTransport) {
    transport.stderr?.on("data", (chunk: Buffer) => {
      logDebug(`mcp[${serverName}] ${chunk.toString("utf8").trimEnd()}`);
    });
  }
  const client = new Client({ name: "openma-pi-acp", version: VERSION });
  await client.connect(transport);
  const listed = await client.listTools();
  const tools: ToolDefinition[] = listed.tools.map((tool) => {
    const name = mcpToolName(serverName, tool.name);
    const definition: ToolDefinition = {
      name,
      label: `${serverName}: ${tool.name}`,
      description: tool.description ?? `${tool.name} (MCP server ${serverName})`,
      parameters: schemaFromMcp(tool.inputSchema),
      promptSnippet:
        tool.description !== undefined ? `${tool.description.split("\n", 1)[0] ?? ""}` : undefined,
      execute: async (_toolCallId, params, signal) => {
        const result = await client.callTool(
          { name: tool.name, arguments: (params ?? {}) as Record<string, unknown> },
          undefined,
          signal !== undefined ? { signal } : undefined,
        );
        const record = result as { content?: unknown; isError?: boolean; structuredContent?: unknown };
        const content = contentFromMcp(record.content);
        if (record.isError === true) {
          const text = content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
          throw new Error(text.length > 0 ? text : `MCP tool ${tool.name} failed`);
        }
        return {
          content: content.length > 0 ? content : [{ type: "text", text: "(no output)" }],
          details: { server: serverName, tool: tool.name, structuredContent: record.structuredContent },
        };
      },
    };
    return definition;
  });
  logDebug(`mounted MCP server "${serverName}" with ${tools.length} tool(s)`);
  return {
    name: serverName,
    tools,
    close: async () => {
      try {
        await client.close();
      } catch (error: unknown) {
        logDebug(`closing MCP server "${serverName}": ${errorMessage(error)}`);
      }
    },
  };
}

export async function mountMcpServers(
  servers: readonly McpServer[] | undefined,
  cwd: string,
): Promise<McpMountResult> {
  const mounts: McpMount[] = [];
  const diagnostics: string[] = [];
  if (servers === undefined || servers.length === 0) return { mounts, tools: [], diagnostics };
  const taken = new Set<string>();
  await Promise.all(
    servers.map(async (server) => {
      const base = sanitizeServerName((server as { name?: unknown }).name as string);
      let serverName = base;
      for (let n = 2; taken.has(serverName); n += 1) serverName = `${base.slice(0, 28)}_${n}`;
      taken.add(serverName);
      try {
        mounts.push(await mountOne(server, cwd, serverName));
      } catch (error: unknown) {
        const message = `MCP server "${serverName}" unavailable: ${errorMessage(error)}`;
        logWarn(message);
        diagnostics.push(message);
      }
    }),
  );
  return { mounts, tools: mounts.flatMap((mount) => mount.tools), diagnostics };
}
