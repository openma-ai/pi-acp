/**
 * E2E: ACP `additionalDirectories` → extra roots (and their context files) in
 * the system prompt; unusable entries reported as diagnostics.
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

describe("additionalDirectories", () => {
  it("advertises the capability and injects the directories with their AGENTS.md", async () => {
    harness = await Harness.create();
    const init = await harness.initialize();
    expect(init.agentCapabilities?.sessionCapabilities).toMatchObject({ additionalDirectories: {} });

    const lib = join(harness.root, "lib");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "AGENTS.md"), "# lib rules\nAlways run lib tests.\n");
    const created = await harness.client.newSession({
      cwd: harness.workspace,
      mcpServers: [],
      additionalDirectories: [lib, harness.workspace, "relative/dir", join(harness.root, "missing")],
    });
    const meta = (created._meta as { pi: { additionalDirectories: string[]; diagnostics: string[] } }).pi;
    expect(meta.additionalDirectories).toEqual([lib]);
    expect(meta.diagnostics).toEqual([
      expect.stringContaining("relative/dir skipped: not an absolute path"),
      expect.stringContaining("missing skipped: does not exist"),
    ]);

    let systemPrompt = "";
    harness.respond((context) => {
      systemPrompt = context.systemPrompt ?? "";
      return fauxAssistantMessage("ok");
    });
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "hi" }] });
    expect(systemPrompt).toContain("# Additional workspace directories");
    expect(systemPrompt).toContain(`- ${lib}`);
    expect(systemPrompt).toContain(`## Context from ${join(lib, "AGENTS.md")}`);
    expect(systemPrompt).toContain("Always run lib tests.");
  });

  it("leaves the system prompt untouched without additional directories", async () => {
    harness = await Harness.create();
    await harness.initialize();
    const sessionId = await harness.newSession();
    let systemPrompt = "";
    harness.respond((context) => {
      systemPrompt = context.systemPrompt ?? "";
      return fauxAssistantMessage("ok");
    });
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });
    expect(systemPrompt).not.toContain("Additional workspace directories");
  });
});
