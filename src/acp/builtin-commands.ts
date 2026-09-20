/**
 * Adapter-level slash commands executed without a model turn.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../log.ts";
import { modelValue } from "./config-options.ts";
import { isPermissionMode, PERMISSION_MODES } from "./permissions.ts";
import { parseMcpToolName } from "./tool-facts.ts";
import type { PiAcpSession } from "./session.ts";
import { VERSION } from "../version.ts";

export interface CommandOutcome {
  text: string;
  /** Surfaces changed by the command; the agent republishes them. */
  refresh?: { config?: boolean; commands?: boolean; mode?: boolean; title?: string };
}

function onOff(value: string): boolean | undefined {
  const lowered = value.toLowerCase();
  if (["on", "true", "enable", "enabled", "1"].includes(lowered)) return true;
  if (["off", "false", "disable", "disabled", "0"].includes(lowered)) return false;
  return undefined;
}

export async function runBuiltinCommand(
  session: PiAcpSession,
  name: string,
  args: string,
): Promise<CommandOutcome | undefined> {
  const pi = session.session;
  switch (name) {
    case "status": {
      const model = pi.model;
      const usage = pi.getContextUsage();
      const stats = pi.getSessionStats();
      const rows = [
        ["Adapter", `openma-pi-acp ${VERSION} (pi ${PI_VERSION})`],
        ["Model", model !== undefined ? `${modelValue(model)} (${model.name})` : "(none)"],
        ["Thinking", pi.thinkingLevel],
        ["Permissions", session.policy.mode],
        ["Auto-compaction", pi.autoCompactionEnabled ? "on" : "off"],
        ["Workspace", session.cwd],
        ["Session", `${pi.sessionId}${pi.sessionFile !== undefined ? ` — ${pi.sessionFile}` : ""}`],
        [
          "Messages",
          `${stats.userMessages} user / ${stats.assistantMessages} assistant / ${stats.toolCalls} tool calls`,
        ],
        ["Tokens", `${stats.tokens.total.toLocaleString()} total (cost $${stats.cost.toFixed(4)})`],
        ...(usage !== undefined && usage.tokens !== null
          ? [
              [
                "Context",
                `${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} (${usage.percent ?? 0}%)`,
              ],
            ]
          : []),
        ["Tools", pi.getActiveToolNames().join(", ")],
      ];
      const diagnostics = session.diagnostics;
      return {
        text: [
          "| | |",
          "|---|---|",
          ...rows.map(([key, value]) => `| ${key} | ${value} |`),
          ...(diagnostics.length > 0 ? ["", "Diagnostics:", ...diagnostics.map((d) => `- ${d}`)] : []),
        ].join("\n"),
      };
    }
    case "model": {
      const models = pi.modelRuntime.getAvailableSnapshot();
      const current = pi.model !== undefined ? modelValue(pi.model) : undefined;
      if (args.length === 0) {
        const lines = models.map(
          (m) => `${modelValue(m) === current ? "→" : " "} ${modelValue(m)} — ${m.name}`,
        );
        return {
          text: [
            `model: ${current ?? "(none)"}`,
            "",
            ...(lines.length > 0 ? lines : ["no models available — authenticate first"]),
            "",
            "switch with /model <provider/id>",
          ].join("\n"),
        };
      }
      try {
        await session.setModel(args);
      } catch (error: unknown) {
        return { text: `⚠ ${errorMessage(error)}` };
      }
      return {
        text: `model → ${pi.model !== undefined ? modelValue(pi.model) : args}`,
        refresh: { config: true },
      };
    }
    case "thinking": {
      const levels = pi.getAvailableThinkingLevels();
      if (args.length === 0)
        return { text: `thinking: ${pi.thinkingLevel} (available: ${levels.join(", ")})` };
      try {
        session.setThinking(args.toLowerCase());
      } catch (error: unknown) {
        return { text: `⚠ ${errorMessage(error)}` };
      }
      return { text: `thinking → ${pi.thinkingLevel}`, refresh: { config: true } };
    }
    case "mode": {
      if (args.length === 0)
        return {
          text: `permission mode: ${session.policy.mode} (available: ${PERMISSION_MODES.join(", ")})`,
        };
      const mode = args.toLowerCase();
      if (!isPermissionMode(mode))
        return { text: `⚠ unknown mode "${args}"; use ${PERMISSION_MODES.join(" | ")}` };
      session.setMode(mode);
      return { text: `permission mode → ${mode}`, refresh: { config: true, mode: true } };
    }
    case "compact": {
      try {
        const result = await pi.compact(args.length > 0 ? args : undefined);
        return {
          text: `Compaction completed (${result.tokensBefore.toLocaleString()} tokens before).\n\n${result.summary}`,
        };
      } catch (error: unknown) {
        return { text: `⚠ compaction failed: ${errorMessage(error)}` };
      }
    }
    case "autocompact": {
      const requested =
        args.length === 0 || args.toLowerCase() === "toggle" ? !pi.autoCompactionEnabled : onOff(args);
      if (requested === undefined) return { text: "usage: /autocompact on|off|toggle" };
      pi.setAutoCompactionEnabled(requested);
      return { text: `auto-compaction ${requested ? "enabled" : "disabled"}`, refresh: { config: true } };
    }
    case "name":
    case "rename": {
      if (args.length === 0)
        return { text: `session name: ${pi.sessionName ?? "(unset)"}\nusage: /${name} <name>` };
      pi.setSessionName(args);
      return { text: `session name → ${args}`, refresh: { title: args } };
    }
    case "mcp": {
      const active = new Set(pi.getActiveToolNames());
      const byServer = new Map<string, string[]>();
      for (const tool of pi.getAllTools()) {
        const parsed = parseMcpToolName(tool.name);
        if (parsed === undefined) continue;
        const list = byServer.get(parsed.server) ?? [];
        list.push(`${active.has(tool.name) ? "[x]" : "[ ]"} ${parsed.tool}`);
        byServer.set(parsed.server, list);
      }
      if (byServer.size === 0) return { text: "No MCP servers are mounted in this session." };
      return {
        text: [...byServer.entries()]
          .map(([server, tools]) => [`**${server}**`, ...tools].join("\n"))
          .join("\n\n"),
      };
    }
    case "skills": {
      const skills = pi.resourceLoader.getSkills().skills;
      if (skills.length === 0) return { text: "No skills are available." };
      const enabled = pi.settingsManager.getEnableSkillCommands();
      return {
        text: [
          ...skills.map((skill) => `- **${skill.name}** — ${skill.description}`),
          "",
          enabled ? "invoke with /skill:<name> <instructions>" : "skill commands are disabled in pi settings",
        ].join("\n"),
      };
    }
    case "session": {
      const stats = pi.getSessionStats();
      const t = stats.tokens;
      return {
        text: [
          `Session: ${stats.sessionId}`,
          ...(stats.sessionFile !== undefined ? [`File: ${stats.sessionFile}`] : []),
          `Messages: ${stats.totalMessages} (${stats.userMessages} user, ${stats.assistantMessages} assistant, ${stats.toolCalls} tool calls)`,
          `Tokens: in ${t.input.toLocaleString()}, out ${t.output.toLocaleString()}, cache read ${t.cacheRead.toLocaleString()}, cache write ${t.cacheWrite.toLocaleString()}, total ${t.total.toLocaleString()}`,
          `Cost: $${stats.cost.toFixed(4)}`,
        ].join("\n"),
      };
    }
    case "export": {
      if (pi.messages.length === 0) return { text: "Nothing to export yet — send a prompt first." };
      try {
        const path = await pi.exportToHtml(args.length > 0 ? args : undefined);
        return { text: `Session exported: ${path}` };
      } catch (error: unknown) {
        return { text: `⚠ export failed: ${errorMessage(error)}` };
      }
    }
    case "tools": {
      const all = pi.getAllTools().map((tool) => tool.name);
      const active = new Set(pi.getActiveToolNames());
      if (args.length === 0) {
        return {
          text: [
            "tools:",
            ...all.map((name) => `${active.has(name) ? "[x]" : "[ ]"} ${name}`),
            "",
            "set with /tools <name…>",
          ].join("\n"),
        };
      }
      const requested = args.split(/[\s,]+/).filter((name) => name.length > 0);
      const unknown = requested.filter((name) => !all.includes(name));
      if (unknown.length > 0) return { text: `⚠ unknown tools: ${unknown.join(", ")}` };
      pi.setActiveToolsByName(requested);
      return { text: `active tools → ${pi.getActiveToolNames().join(", ")}` };
    }
    case "steering":
    case "follow-up": {
      const isSteering = name === "steering";
      const current = isSteering ? pi.steeringMode : pi.followUpMode;
      if (args.length === 0) return { text: `${name} mode: ${current}` };
      const mode = args.toLowerCase();
      if (mode !== "all" && mode !== "one-at-a-time") return { text: `usage: /${name} all | one-at-a-time` };
      if (isSteering) pi.setSteeringMode(mode);
      else pi.setFollowUpMode(mode);
      return { text: `${name} mode → ${mode}` };
    }
    case "queue": {
      if (args.toLowerCase() === "clear") {
        const cleared = pi.clearQueue();
        return { text: `cleared ${cleared.steering.length + cleared.followUp.length} queued message(s)` };
      }
      const steering = pi.getSteeringMessages();
      const followUp = pi.getFollowUpMessages();
      return {
        text: [
          `queued: ${steering.length} steering, ${followUp.length} follow-up`,
          ...steering.map((m) => `- [steer] ${m.split("\n", 1)[0]}`),
          ...followUp.map((m) => `- [follow-up] ${m.split("\n", 1)[0]}`),
        ].join("\n"),
      };
    }
    case "bash": {
      if (args.length === 0) return { text: "usage: /bash <command>" };
      const toolCallId = `user-bash-${Date.now().toString(36)}`;
      session.emit({
        sessionUpdate: "tool_call",
        toolCallId,
        title: args.split("\n", 1)[0] ?? "bash",
        name: "bash",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: args },
      });
      let output = "";
      try {
        const result = await pi.executeBash(args, (chunk) => {
          output += chunk;
          session.emit({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
            content: [
              {
                type: "content",
                content: { type: "text", text: `\`\`\`sh\n${output.replace(/\n+$/, "")}\n\`\`\`\n` },
              },
            ],
          });
        });
        const failed = result.cancelled || (result.exitCode !== undefined && result.exitCode !== 0);
        session.emit({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: failed ? "failed" : "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: `\`\`\`sh\n${result.output.replace(/\n+$/, "")}\n\`\`\`\n` },
            },
          ],
          rawOutput: { output: result.output, exitCode: result.exitCode, cancelled: result.cancelled },
        });
        return { text: `exit ${result.exitCode ?? "?"}${result.cancelled ? " (cancelled)" : ""}` };
      } catch (error: unknown) {
        session.emit({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
          rawOutput: { error: errorMessage(error) },
        });
        return { text: `⚠ ${errorMessage(error)}` };
      }
    }
    case "reload": {
      try {
        await pi.reload();
      } catch (error: unknown) {
        return { text: `⚠ reload failed: ${errorMessage(error)}` };
      }
      return {
        text: "reloaded extensions, skills, prompts, and context files",
        refresh: { commands: true, config: true },
      };
    }
    case "changelog": {
      const path = join(getPackageDir(), "CHANGELOG.md");
      if (!existsSync(path)) return { text: `pi changelog not found (${path})` };
      let text = readFileSync(path, "utf8");
      if (text.length > 20_000) text = `${text.slice(0, 20_000)}\n\n…(truncated)`;
      return { text };
    }
    default:
      return undefined;
  }
}
