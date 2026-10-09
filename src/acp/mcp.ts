/**
 * Register client-supplied ACP MCP servers on pi's MCP extension.
 *
 * pi 1.1.0 connects stdio and streamable HTTP itself (`createMcpExtension`),
 * names tools `mcp__<server>__<tool>`, and loads them through `tool_search`
 * when exposure is `deferred`. ACP servers use that exposure so a client sees
 * a real `tool_call` for the MCP tool after search, instead of every tool
 * being declared up front. Legacy SSE is rejected by pi, so it stays unadvertised.
 *
 * The registration is in-memory and dies with the session. `mcp.json` is not
 * read: pi's loader would ignore `--agent-dir`, and the client's list is the
 * whole set (an empty list leaves no ACP servers). Header and env values are
 * escaped so pi treats them as literals (`$` / leading `!` are interpolation
 * in pi's own config).
 */
import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import {
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
  type McpServerConfig,
} from "@earendil-works/pi-coding-agent";
import { errorMessage, logWarn } from "../log.ts";

export interface PlannedMcpServer {
  name: string;
  config: McpServerConfig;
}

export interface AcpMcpPlan {
  servers: PlannedMcpServer[];
  diagnostics: string[];
  extension: InlineExtension;
}

function sanitizeServerName(raw: string): string {
  const name = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  return (name.length > 0 ? name : "server").slice(0, 64);
}

/** pi treats names that differ only by `-` and `_` as one server. */
function namespaceKey(name: string): string {
  return name.replace(/-/g, "_");
}

function uniqueServerName(raw: string, taken: Set<string>): string {
  const base = sanitizeServerName(raw);
  let name = base;
  for (let index = 2; taken.has(namespaceKey(name)); index += 1) {
    const suffix = `_${index}`;
    name = base.slice(0, 64 - suffix.length) + suffix;
  }
  taken.add(namespaceKey(name));
  return name;
}

/**
 * pi expands `${VAR}`, `$VAR`, and a leading `!command` in header and env
 * values. ACP already supplies the literal, so escape those spellings.
 */
export function literalConfigValue(value: string): string {
  // `replaceAll` treats `$$` in the replacement as one `$`, so four dollars emit two.
  const escaped = value.replaceAll("$", "$$$$");
  return escaped.startsWith("!") ? `$!${escaped.slice(1)}` : escaped;
}

/** Same acceptance rules pi applies in `validateMcpServerConfig` for the fields ACP sets. */
function invalidConfig(name: string, config: McpServerConfig): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(name))
    return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
  if ("url" in config) {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      return "url must be an http or https URL";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "url must be an http or https URL";
  } else if (config.command.length === 0) {
    return "command must not be empty";
  }
  return undefined;
}

function configFor(server: McpServer): McpServerConfig | string {
  if ("type" in server && server.type === "sse") {
    return "legacy SSE transport is not supported; use the streamable HTTP URL";
  }
  if ("type" in server && server.type === "acp") {
    return "ACP-transport MCP servers are not supported";
  }
  if ("command" in server) {
    const env: Record<string, string> = {};
    for (const entry of server.env) env[entry.name] = literalConfigValue(entry.value);
    return { command: server.command, args: [...server.args], env, exposure: "deferred" };
  }
  if ("type" in server && server.type === "http") {
    const headers: Record<string, string> = {};
    for (const header of server.headers) headers[header.name] = literalConfigValue(header.value);
    return { type: "http", url: server.url, headers, exposure: "deferred" };
  }
  return "unsupported MCP transport (stdio and streamable HTTP are supported)";
}

/**
 * Hidden pi extensions that connect MCP and the tools that reach indirect servers.
 *
 * File `mcp.json` is not loaded. The extension's default reader always uses
 * `getAgentDir()`, which ignores this process's `--agent-dir`, and an ACP
 * session's servers are the ones the client sent. `logPath` still follows the
 * session agent directory.
 */
export function piMcpExtensions(agentDir: string): InlineExtension[] {
  return [
    { name: "tool-search", hidden: true, factory: createToolSearchExtension() },
    {
      name: "mcp",
      hidden: true,
      factory: createMcpExtension({
        loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: true }),
        logPath: join(agentDir, "mcp.log"),
      }),
    },
  ];
}

export function planAcpMcpServers(servers: readonly McpServer[] | undefined): AcpMcpPlan {
  const diagnostics: string[] = [];
  const planned: PlannedMcpServer[] = [];
  const taken = new Set<string>();
  for (const server of servers ?? []) {
    const name = uniqueServerName(server.name, taken);
    const config = configFor(server);
    if (typeof config === "string") {
      diagnostics.push(`MCP server "${name}" unavailable: ${config}`);
      continue;
    }
    const invalid = invalidConfig(name, config);
    if (invalid !== undefined) {
      diagnostics.push(`MCP server "${name}" unavailable: ${invalid}`);
      continue;
    }
    planned.push({ name, config });
  }
  const extension: InlineExtension = {
    name: "acp-mcp",
    hidden: true,
    factory(pi) {
      for (const server of planned) {
        try {
          pi.registerMcpServer(server.name, server.config);
        } catch (error: unknown) {
          const diagnostic = `MCP server "${server.name}" unavailable: ${errorMessage(error)}`;
          diagnostics.push(diagnostic);
          logWarn(diagnostic);
        }
      }
    },
  };
  return { servers: planned, diagnostics, extension };
}
