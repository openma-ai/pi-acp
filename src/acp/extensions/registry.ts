/**
 * Third-party pi extensions the adapter knows how to surface as first-class
 * ACP features. pi has no multi-root primitive; when the user has installed
 * the extension that provides one, the adapter maps that extension's own wire
 * shapes (commands, session entries) onto ACP. Nothing here is invented:
 * absent the extension, the ACP feature is absent too.
 *
 * Detection is by package identity (settings `packages` / `extensions` at
 * `initialize`, the loaded-extension inventory once a session exists).
 */

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { errorMessage, logDebug } from "../../log.ts";
import type { ExtensionInventoryEntry } from "../extension-inventory.ts";

export type KnownExtensionId = "pi-add-dir";

export interface KnownExtension {
  id: KnownExtensionId;
  /** npm package name. */
  package: string;
  /** Substrings that identify the package in a pi source label or path. */
  markers: readonly string[];
  /** Tool the extension registers; a second, structural signal. */
  tool: string;
  /** What the adapter gains from it. */
  provides: "additionalDirectories";
}

export const KNOWN_EXTENSIONS: readonly KnownExtension[] = [
  {
    id: "pi-add-dir",
    package: "pi-add-dir",
    markers: ["pi-add-dir"],
    tool: "add_directory",
    provides: "additionalDirectories",
  },
];

function matches(extension: KnownExtension, label: string): boolean {
  const lowered = label.toLowerCase();
  return extension.markers.some((marker) => lowered.includes(marker));
}

/** Known extensions referenced by pi settings (`packages`, `extensions`) — usable before any session exists. */
export function detectFromSettings(cwd: string, agentDir: string): Set<KnownExtensionId> {
  const found = new Set<KnownExtensionId>();
  let labels: string[] = [];
  try {
    const settings = SettingsManager.create(cwd, agentDir);
    labels = [
      ...settings.getPackages().map((pkg) => (typeof pkg === "string" ? pkg : pkg.source)),
      ...settings.getExtensionPaths(),
    ];
  } catch (error: unknown) {
    logDebug(`settings scan for known extensions failed: ${errorMessage(error)}`);
  }
  for (const extension of KNOWN_EXTENSIONS) {
    if (labels.some((label) => matches(extension, label))) found.add(extension.id);
  }
  return found;
}

/** Known extensions actually loaded in a session (package identity or its tool). */
export function detectFromInventory(inventory: readonly ExtensionInventoryEntry[]): Set<KnownExtensionId> {
  const found = new Set<KnownExtensionId>();
  for (const extension of KNOWN_EXTENSIONS) {
    for (const entry of inventory) {
      if (matches(extension, entry.source) || matches(extension, entry.path)) {
        if (entry.tools.includes(extension.tool)) found.add(extension.id);
      }
    }
  }
  return found;
}

export function knownExtension(id: KnownExtensionId): KnownExtension {
  return KNOWN_EXTENSIONS.find((extension) => extension.id === id)!;
}
