/**
 * Adapter settings: flags win over environment variables, which win over defaults.
 */

import { isAbsolute, resolve } from "node:path";
import { DEFAULT_PERMISSION_MODE, isPermissionMode, type PermissionMode } from "./acp/permissions.ts";

export interface Settings {
  /** pi agent dir (`~/.pi/agent`). */
  agentDir: string | undefined;
  /** Initial permission mode for new sessions. */
  permissionMode: PermissionMode;
  /** `provider/model[:thinking]` override for new sessions. */
  model: string | undefined;
  /** Emit a startup banner (pi version, resources) into new sessions. */
  quietStartup: boolean | undefined;
  /** Trust every project cwd (loads `.pi/` extensions) without a stored decision. */
  trustProjects: boolean;
  /** Use the client's fs/terminal capabilities when advertised. */
  delegation: boolean;
  /** Custom session directory (pi `--session-dir`). */
  sessionDir: string | undefined;
}

export class SettingsError extends Error {}

export const HELP_TEXT = `openma-pi-acp — Agent Client Protocol server for the pi coding agent

Usage: openma-pi-acp [options]
       openma-pi-acp --terminal-login       Launch pi interactively (login / setup)
       openma-pi-acp --version | --help

Options:
  --agent-dir <path>        pi config dir (default ~/.pi/agent; env PI_CODING_AGENT_DIR)
  --permission-mode <m>     read-only | ask | full-access (default ask; env PI_ACP_PERMISSION_MODE)
  --model <provider/id>     Model for new sessions (env PI_ACP_MODEL)
  --session-dir <path>      Session storage dir (env PI_ACP_SESSION_DIR)
  --trust-projects          Load project .pi/ resources everywhere (env PI_ACP_TRUST_PROJECTS=1)
  --no-delegation           Never use client fs/terminal delegation (env PI_ACP_DELEGATION=0)
  --quiet-startup           Skip the startup banner (env PI_ACP_QUIET_STARTUP=1)

Diagnostics: PI_ACP_DEBUG=1 for verbose stderr logging.
`;

function envFlag(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  return !(value === "0" || value.toLowerCase() === "false" || value.toLowerCase() === "off");
}

export function resolveSettings(argv: readonly string[]): Settings {
  let agentDir = process.env["PI_CODING_AGENT_DIR"];
  let permissionMode: string | undefined = process.env["PI_ACP_PERMISSION_MODE"];
  let model = process.env["PI_ACP_MODEL"];
  let sessionDir = process.env["PI_ACP_SESSION_DIR"];
  let trustProjects = envFlag("PI_ACP_TRUST_PROJECTS") ?? false;
  let delegation = envFlag("PI_ACP_DELEGATION") ?? true;
  let quietStartup = envFlag("PI_ACP_QUIET_STARTUP");

  const take = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new SettingsError(`${flag} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const eq = arg.indexOf("=");
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = take(i, flag);
      i += 1;
      return v;
    };
    switch (flag) {
      case "--agent-dir":
        agentDir = value();
        break;
      case "--permission-mode":
        permissionMode = value();
        break;
      case "--model":
        model = value();
        break;
      case "--session-dir":
        sessionDir = value();
        break;
      case "--trust-projects":
        trustProjects = true;
        break;
      case "--no-delegation":
        delegation = false;
        break;
      case "--quiet-startup":
        quietStartup = true;
        break;
      case "--terminal-login":
      case "--version":
      case "--help":
        break;
      default:
        throw new SettingsError(`unknown option: ${arg}`);
    }
  }

  if (permissionMode !== undefined && !isPermissionMode(permissionMode)) {
    throw new SettingsError(`invalid --permission-mode: ${permissionMode}`);
  }

  return {
    agentDir: agentDir !== undefined ? (isAbsolute(agentDir) ? agentDir : resolve(agentDir)) : undefined,
    permissionMode: (permissionMode as PermissionMode | undefined) ?? DEFAULT_PERMISSION_MODE,
    model,
    quietStartup,
    trustProjects,
    delegation,
    sessionDir:
      sessionDir !== undefined ? (isAbsolute(sessionDir) ? sessionDir : resolve(sessionDir)) : undefined,
  };
}
