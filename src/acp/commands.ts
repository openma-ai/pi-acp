/**
 * Slash command surface: adapter built-ins + pi prompt templates + skills +
 * extension commands, published as ACP `available_commands_update`.
 */

import type { AvailableCommand } from "@agentclientprotocol/sdk";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export interface BuiltinCommand extends AvailableCommand {
  name: string;
  description: string;
}

/**
 * `_meta.commandAction`: a display hint (Codex convention) telling clients that a
 * command mutates session state rather than starting a turn, so they can render
 * it as a state control and refresh config options afterwards.
 */
function stateCommand(configId: string): { _meta: Record<string, unknown> } {
  return { _meta: { commandAction: { kind: "setConfigOption", configId, presentation: "state" } } };
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: "status", description: "Show adapter, model, mode, and session status" },
  {
    name: "model",
    description: "List models or switch model",
    input: { hint: "[provider/model] — blank lists" },
    ...stateCommand("model"),
  },
  {
    name: "thinking",
    description: "Show or set the thinking level",
    input: { hint: "off|minimal|low|medium|high|xhigh|max" },
    ...stateCommand("thinking"),
  },
  {
    name: "mode",
    description: "Show or set the permission mode",
    input: { hint: "read-only|ask|full-access" },
    ...stateCommand("mode"),
  },
  {
    name: "compact",
    description: "Compact the conversation context",
    input: { hint: "[custom instructions]" },
  },
  {
    name: "autocompact",
    description: "Toggle automatic compaction",
    input: { hint: "on|off|toggle" },
    ...stateCommand("auto_compaction"),
  },
  { name: "name", description: "Set the session display name", input: { hint: "<name>" } },
  { name: "rename", description: "Rename the current session", input: { hint: "<name>" } },
  { name: "session", description: "Show session statistics (messages, tokens, cost, file)" },
  { name: "export", description: "Export the session to HTML", input: { hint: "[output path]" } },
  { name: "tools", description: "List or set active tools", input: { hint: "[tool names…]" } },
  { name: "mcp", description: "List the MCP servers and tools mounted in this session" },
  { name: "skills", description: "List available skills" },
  {
    name: "steering",
    description: "Show or set steering delivery mode",
    input: { hint: "all|one-at-a-time" },
  },
  {
    name: "follow-up",
    description: "Show or set follow-up delivery mode",
    input: { hint: "all|one-at-a-time" },
  },
  { name: "queue", description: "Show or clear queued messages", input: { hint: "[clear]" } },
  {
    name: "bash",
    description: "Run a shell command in the session cwd (output added to context)",
    input: { hint: "<command>" },
  },
  { name: "reload", description: "Reload extensions, skills, prompts, and context files" },
  { name: "changelog", description: "Show the installed pi changelog" },
];

export function isBuiltinCommand(name: string): boolean {
  return BUILTIN_COMMANDS.some((command) => command.name === name);
}

export interface ParsedSlashCommand {
  name: string;
  args: string;
}

export function parseSlashCommand(text: string): ParsedSlashCommand | undefined {
  const trimmed = text.trimStart();
  const match = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match === null || match[1] === undefined) return undefined;
  return { name: match[1], args: (match[2] ?? "").trim() };
}

export interface CommandSurfaceOptions {
  enableSkillCommands: boolean;
}

export function availableCommandsFor(
  session: AgentSession,
  options: CommandSurfaceOptions,
): AvailableCommand[] {
  const list: AvailableCommand[] = [...BUILTIN_COMMANDS];
  const seen = new Set(list.map((command) => command.name));
  const push = (command: AvailableCommand): void => {
    if (seen.has(command.name)) return;
    seen.add(command.name);
    list.push(command);
  };
  for (const command of session.extensionRunner.getRegisteredCommands()) {
    push({
      name: command.invocationName,
      description: command.description ?? `${command.invocationName} (extension)`,
      _meta: { pi: { source: "extension", path: command.sourceInfo.path } },
    });
  }
  for (const template of session.promptTemplates) {
    push({
      name: template.name,
      description: template.description || `${template.name} (${template.sourceInfo.source})`,
      ...(template.argumentHint !== undefined ? { input: { hint: template.argumentHint } } : {}),
      _meta: { pi: { source: "prompt", path: template.filePath } },
    });
  }
  if (options.enableSkillCommands) {
    for (const skill of session.resourceLoader.getSkills().skills) {
      push({
        name: `skill:${skill.name}`,
        description: skill.description,
        input: { hint: "instructions for the skill" },
        _meta: { pi: { source: "skill", path: skill.filePath } },
      });
    }
  }
  return list;
}
