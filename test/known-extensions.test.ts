/**
 * E2E: ACP `additionalDirectories` backed by the bundled pi-add-dir extension
 * (the real package, loaded into every session).
 */

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledPiAddDirPath } from "../src/acp/extensions/pi-add-dir.ts";
import { fauxAssistantMessage, Harness } from "./helpers/harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function addDirOwners(h: Harness, created: { _meta?: unknown }): string[] {
  const extensions = (created._meta as { pi: { extensions: { path: string; tools: string[] }[] } }).pi
    .extensions;
  return extensions.filter((e) => e.tools.includes("add_directory")).map((e) => e.path);
}

describe("additionalDirectories via bundled pi-add-dir", () => {
  it("advertises the capability and loads the bundled extension into every session", async () => {
    harness = await Harness.create();
    const init = await harness.initialize();
    expect(init.agentCapabilities?.sessionCapabilities?.additionalDirectories).toEqual({});
    const created = await harness.client.newSession({ cwd: harness.workspace, mcpServers: [] });
    expect(addDirOwners(harness, created)).toEqual([bundledPiAddDirPath()]);
    expect((created._meta as { pi: { additionalDirectories: string[] } }).pi.additionalDirectories).toEqual(
      [],
    );
  });

  it("adds requested roots through /add-dir, echoes the extension's state, and survives resume", async () => {
    harness = await Harness.create();
    await harness.initialize();
    const lib = join(harness.root, "lib");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "AGENTS.md"), "# lib\n");
    const created = await harness.client.newSession({
      cwd: harness.workspace,
      mcpServers: [],
      additionalDirectories: [lib, harness.workspace, "relative"],
    });
    const meta = (created._meta as { pi: { additionalDirectories: string[]; diagnostics: string[] } }).pi;
    expect(meta.additionalDirectories).toEqual([realpathSync(lib)]);
    expect(meta.diagnostics).toEqual([expect.stringContaining("relative skipped: not an absolute path")]);
    await harness.settle();
    expect(harness.text(created.sessionId)).toContain("Found: AGENTS.md");

    let systemPrompt = "";
    harness.respond((context) => {
      systemPrompt = context.systemPrompt ?? "";
      return fauxAssistantMessage("hi");
    });
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "hi" }] });
    expect(systemPrompt).toContain(realpathSync(lib));

    await harness.client.closeSession({ sessionId: created.sessionId });
    const resumed = await harness.client.resumeSession({
      sessionId: created.sessionId,
      cwd: harness.workspace,
      mcpServers: [],
      additionalDirectories: [lib],
    });
    expect((resumed._meta as { pi: { additionalDirectories: string[] } }).pi.additionalDirectories).toEqual([
      realpathSync(lib),
    ]);
  });

  it("does not load the bundled copy when the user's pi already installs pi-add-dir", async () => {
    harness = await Harness.create();
    const userCopy = join(harness.agentDir, "extensions", "pi-add-dir.js");
    mkdirSync(join(harness.agentDir, "extensions"), { recursive: true });
    writeFileSync(
      userCopy,
      `import { Type } from "typebox";
export default function (pi) {
  pi.registerCommand("add-dir", { description: "user copy", handler: async () => {} });
  pi.registerTool({ name: "add_directory", description: "x", parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [] }; } });
}`,
    );
    writeFileSync(
      join(harness.agentDir, "settings.json"),
      JSON.stringify({ quietStartup: true, retry: { enabled: false }, extensions: [userCopy] }),
    );
    await harness.initialize();
    const created = await harness.client.newSession({ cwd: harness.workspace, mcpServers: [] });
    expect(addDirOwners(harness, created)).toEqual([userCopy]);
  });
});
