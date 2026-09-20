/**
 * E2E: pi-add-dir surfaced as ACP `additionalDirectories`. The fixture
 * reproduces the extension's documented wire shape (command, state entry) so
 * the adapter is tested against the contract it adapts, without installing it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, Harness } from "./helpers/harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** pi-add-dir: `/add-dir <path>` persists `add-dir:state`; `add_directory` tool exists. */
const PI_ADD_DIR = `
import { Type } from "typebox";
export default function (pi) {
  let dirs = [];
  pi.on("session_start", (_e, ctx) => {
    for (const e of ctx.sessionManager.getBranch()) if (e.type === "custom" && e.customType === "add-dir:state") dirs = e.data.dirs;
  });
  pi.registerCommand("add-dir", { description: "add", handler: async (args, ctx) => {
    if (!args) return;
    if (dirs.some((d) => d.absolutePath === args)) { ctx.ui.notify("Already added: " + args, "error"); return; }
    dirs.push({ absolutePath: args, label: "x", addedAt: 1 });
    pi.appendEntry("add-dir:state", { dirs });
    ctx.ui.notify("Added " + args, "info");
  } });
  pi.registerTool({ name: "add_directory", description: "add", parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [] }; } });
}
`;

function installExtension(h: Harness, file: string, source: string): string {
  const dir = join(h.agentDir, "extensions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, source);
  return path;
}

describe("pi-add-dir → additionalDirectories", () => {
  it("advertises the capability only when the extension is configured", async () => {
    harness = await Harness.create();
    const without = await harness.initialize();
    expect(without.agentCapabilities?.sessionCapabilities?.additionalDirectories).toBeUndefined();
    const created = await harness.client.newSession({
      cwd: harness.workspace,
      mcpServers: [],
      additionalDirectories: [harness.root],
    });
    expect((created._meta as { pi: { diagnostics: string[] } }).pi.diagnostics[0]).toMatch(
      /install pi-add-dir/,
    );
    await harness.close();

    harness = await Harness.create();
    const path = installExtension(harness, "pi-add-dir.js", PI_ADD_DIR);
    writeFileSync(
      join(harness.agentDir, "settings.json"),
      JSON.stringify({ quietStartup: true, retry: { enabled: false }, extensions: [path] }),
    );
    const withExt = await harness.initialize();
    expect(withExt.agentCapabilities?.sessionCapabilities?.additionalDirectories).toEqual({});
  });

  it("drives /add-dir for each requested root and echoes the extension's state", async () => {
    harness = await Harness.create();
    installExtension(harness, "pi-add-dir.js", PI_ADD_DIR);
    await harness.initialize();
    const lib = join(harness.root, "lib");
    mkdirSync(lib, { recursive: true });
    const created = await harness.client.newSession({
      cwd: harness.workspace,
      mcpServers: [],
      additionalDirectories: [lib, harness.workspace, "relative"],
    });
    const meta = (created._meta as { pi: { additionalDirectories: string[]; diagnostics: string[] } }).pi;
    expect(meta.additionalDirectories).toEqual([lib]);
    expect(meta.diagnostics).toEqual([expect.stringContaining("relative skipped: not an absolute path")]);
    const entries = harness
      .updatesFor(created.sessionId)
      .map((u) => (u._meta as { pi?: { event?: string; customType?: string } } | undefined)?.pi)
      .filter((m) => m?.event === "custom_entry" && m.customType === "add-dir:state");
    expect(entries).toHaveLength(1);

    // pi writes the session file on the first assistant message; give it one before resuming.
    harness.respond(fauxAssistantMessage("hi"));
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "hi" }] });
    // Resume with the same list: already tracked, nothing re-added.
    await harness.client.closeSession({ sessionId: created.sessionId });
    const resumed = await harness.client.resumeSession({
      sessionId: created.sessionId,
      cwd: harness.workspace,
      mcpServers: [],
      additionalDirectories: [lib],
    });
    expect((resumed._meta as { pi: { additionalDirectories: string[] } }).pi.additionalDirectories).toEqual([
      lib,
    ]);
  });
});
