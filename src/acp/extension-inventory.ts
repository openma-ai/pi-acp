/**
 * Extension inventory: which loaded extension owns which tool, command, and
 * custom entry type. Published in session responses so clients can route
 * tool calls, `custom_message`s, and `extension_event`s to per-extension
 * adapters without the adapter interpreting any of them.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Name of the inline extension the adapter installs for permission gating. */
export const ADAPTER_EXTENSION_NAME = "openma-acp-permissions";

export interface ExtensionInventoryEntry {
  /** Extension path as pi reports it (package entry or file). */
  path: string;
  /** pi source label: "npm:<pkg>", "git:<url>", "user", "project", "sdk", … */
  source: string;
  scope: string;
  origin: string;
  tools: string[];
  commands: string[];
  /** `customType`s the extension registered renderers for (`sendMessage`/`appendEntry`). */
  customTypes: string[];
}

export function extensionInventory(session: AgentSession): ExtensionInventoryEntry[] {
  const out: ExtensionInventoryEntry[] = [];
  for (const extension of session.resourceLoader.getExtensions().extensions) {
    if (extension.hidden === true) continue;
    if (extension.path === `<inline:${ADAPTER_EXTENSION_NAME}>`) continue; // the adapter's own permission gate
    const customTypes = new Set<string>([
      ...extension.messageRenderers.keys(),
      ...(extension.entryRenderers?.keys() ?? []),
    ]);
    out.push({
      path: extension.path,
      source: extension.sourceInfo.source,
      scope: extension.sourceInfo.scope,
      origin: extension.sourceInfo.origin,
      tools: [...extension.tools.keys()],
      commands: [...extension.commands.keys()],
      customTypes: [...customTypes],
    });
  }
  return out;
}

/** Tool name → owning extension path (extension-registered tools only). */
export function toolOwnerLookup(session: AgentSession): (toolName: string) => string | undefined {
  const owners = new Map<string, string>();
  for (const extension of session.resourceLoader.getExtensions().extensions) {
    for (const name of extension.tools.keys()) owners.set(name, extension.path);
  }
  return (toolName) => owners.get(toolName);
}
