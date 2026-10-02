/**
 * ACP client flow for additionalDirectories: the in-process ClientSideConnection
 * speaks the same methods Martty will (initialize, session/new, prompt, list, load).
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, Harness } from "./helpers/harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function piMeta(response: { _meta?: unknown }): {
  additionalDirectories?: string[];
  additionalDirectoriesEnforced?: boolean;
  sessionFile?: string;
  diagnostics?: string[];
} {
  return (
    response._meta as {
      pi: {
        additionalDirectories?: string[];
        additionalDirectoriesEnforced?: boolean;
        sessionFile?: string;
        diagnostics?: string[];
      };
    }
  ).pi;
}

function failedTools(sessionId: string): string {
  return (harness?.updatesFor(sessionId) ?? [])
    .filter((update) => update.sessionUpdate === "tool_call_update" && update.status === "failed")
    .map((update) => JSON.stringify(update))
    .join("\n");
}

async function turn(
  sessionId: string,
  call: ReturnType<typeof fauxToolCall>,
  followUp = "done",
): Promise<void> {
  harness?.respond(fauxAssistantMessage([call]), fauxAssistantMessage(followUp));
  await harness?.client.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
}

describe("additionalDirectories client flow", () => {
  it("reads and writes every root, rejects the outside, and keeps the list across reload", async () => {
    harness = await Harness.create();
    const init = await harness.initialize();
    expect(init.agentCapabilities?.sessionCapabilities?.additionalDirectories).toEqual({});

    const lib = join(harness.root, "lib");
    const docs = join(harness.root, "docs");
    const notes = join(harness.root, "notes");
    const outside = join(harness.root, "outside");
    mkdirSync(lib, { recursive: true });
    mkdirSync(docs, { recursive: true });
    mkdirSync(notes, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(harness.workspace, "AGENTS.md"), "UNIQUE_CWD_AGENTS\n");
    writeFileSync(join(lib, "AGENTS.md"), "UNIQUE_LIB_AGENTS\n");
    writeFileSync(join(lib, "a.txt"), "from-lib\n");
    writeFileSync(join(docs, "b.txt"), "from-docs\n");
    writeFileSync(join(notes, "c.txt"), "from-notes\n");
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    symlinkSync(join(outside, "secret.txt"), join(harness.workspace, "leak.txt"));

    await expect(
      harness.client.newSession({
        cwd: harness.workspace,
        mcpServers: [],
        additionalDirectories: ["relative"],
      }),
    ).rejects.toThrow(/absolute path/);
    await expect(
      harness.client.newSession({ cwd: harness.workspace, mcpServers: [], additionalDirectories: ["/"] }),
    ).rejects.toThrow(/filesystem root/);
    await expect(
      harness.client.newSession({
        cwd: harness.workspace,
        mcpServers: [],
        additionalDirectories: [homedir()],
      }),
    ).rejects.toThrow(/home directory/);

    const created = await harness.client.newSession({
      cwd: harness.workspace,
      mcpServers: [],
      additionalDirectories: [lib, docs, harness.workspace],
    });
    const sessionId = created.sessionId;
    const roots = [realpathSync(lib), realpathSync(docs)];
    expect(piMeta(created).additionalDirectories).toEqual(roots);
    expect(piMeta(created).additionalDirectoriesEnforced).toBe(true);

    let systemPrompt = "";
    harness.respond((context) => {
      systemPrompt = context.systemPrompt ?? "";
      return fauxAssistantMessage("hi");
    });
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });
    expect(systemPrompt).toContain("UNIQUE_CWD_AGENTS");
    expect(systemPrompt).toContain(realpathSync(lib));
    expect(systemPrompt).not.toContain("UNIQUE_LIB_AGENTS");

    await turn(sessionId, fauxToolCall("read", { path: join(lib, "a.txt") }));
    expect(failedTools(sessionId)).not.toContain("outside the session workspace");
    expect(JSON.stringify(harness.updatesFor(sessionId))).toContain("from-lib");

    await turn(sessionId, fauxToolCall("write", { path: join(docs, "out.txt"), content: "wrote-docs\n" }));
    expect(readFileSync(join(docs, "out.txt"), "utf8")).toBe("wrote-docs\n");

    await turn(sessionId, fauxToolCall("write", { path: "cwd.txt", content: "wrote-cwd\n" }));
    expect(readFileSync(join(harness.workspace, "cwd.txt"), "utf8")).toBe("wrote-cwd\n");

    const failuresBefore = failedTools(sessionId);
    await turn(sessionId, fauxToolCall("read", { path: join(outside, "secret.txt") }));
    expect(failedTools(sessionId).slice(failuresBefore.length)).toContain("outside the session workspace");
    await turn(sessionId, fauxToolCall("read", { path: "leak.txt" }));
    expect(failedTools(sessionId)).toContain("outside the session workspace");
    await turn(sessionId, fauxToolCall("write", { path: join(outside, "pwn.txt"), content: "nope\n" }));
    expect(existsSync(join(outside, "pwn.txt"))).toBe(false);
    await turn(sessionId, fauxToolCall("bash", { command: `cat ${join(outside, "secret.txt")}` }));
    expect(failedTools(sessionId)).toContain(join(outside, "secret.txt"));
    expect(JSON.stringify(harness.updatesFor(sessionId))).not.toContain("secret\\n");

    await turn(sessionId, fauxToolCall("bash", { command: 'echo "see /tmp"' }));
    expect(failedTools(sessionId)).toContain("/tmp");

    await turn(sessionId, fauxToolCall("bash", { command: `cat ${join(lib, "a.txt")}` }));
    expect(JSON.stringify(harness.updatesFor(sessionId))).toContain("from-lib");

    const bash = await harness.client.prompt({
      sessionId,
      prompt: [{ type: "text", text: `/bash cat ${join(outside, "secret.txt")}` }],
    });
    expect(bash.stopReason).toBe("end_turn");
    expect(harness.text(sessionId)).toContain("outside the session workspace");

    await harness.client.closeSession({ sessionId });
    const sessionFile = piMeta(created).sessionFile;
    expect(sessionFile).toBeTruthy();
    expect(readFileSync(sessionFile!, "utf8")).toContain("pi-acp:additional-directories");
    const listed = await harness.client.listSessions({ cwd: harness.workspace });
    expect(listed.sessions.find((session) => session.sessionId === sessionId)?.additionalDirectories).toEqual(
      roots,
    );

    harness.notifications.length = 0;
    const loaded = await harness.client.loadSession({ sessionId, cwd: harness.workspace, mcpServers: [] });
    expect(piMeta(loaded).additionalDirectories).toEqual([]);
    expect(piMeta(loaded).additionalDirectoriesEnforced).toBe(false);
    await turn(sessionId, fauxToolCall("read", { path: join(outside, "secret.txt") }));
    expect(JSON.stringify(harness.updatesFor(sessionId))).toContain("secret\\n");
    const listedAfterOmit = await harness.client.listSessions({ cwd: harness.workspace });
    expect(
      listedAfterOmit.sessions.find((session) => session.sessionId === sessionId)?.additionalDirectories,
    ).toEqual([]);

    const restored = await harness.client.loadSession({
      sessionId,
      cwd: harness.workspace,
      mcpServers: [],
      _meta: { pi: { restoreAdditionalDirectories: true } },
    });
    expect(piMeta(restored).additionalDirectories).toEqual(roots);
    expect(piMeta(restored).additionalDirectoriesEnforced).toBe(true);
    const forked = await harness.client.unstable_forkSession({ sessionId, cwd: harness.workspace });
    expect(piMeta(forked).additionalDirectories).toEqual([]);
    expect(piMeta(forked).additionalDirectoriesEnforced).toBe(false);
    await turn(forked.sessionId, fauxToolCall("read", { path: join(outside, "secret.txt") }));
    expect(JSON.stringify(harness.updatesFor(forked.sessionId))).toContain("secret\\n");

    await turn(sessionId, fauxToolCall("read", { path: join(docs, "out.txt") }));
    expect(JSON.stringify(harness.updatesFor(sessionId))).toContain("wrote-docs");
    await turn(sessionId, fauxToolCall("read", { path: join(outside, "secret.txt") }));
    expect(failedTools(sessionId)).toContain("outside the session workspace");

    const grown = await harness.client.extMethod("_pi/add_directory", { sessionId, path: notes });
    expect(grown).toEqual({ additionalDirectories: [...roots, realpathSync(notes)] });
    await turn(sessionId, fauxToolCall("read", { path: join(notes, "c.txt") }));
    expect(JSON.stringify(harness.updatesFor(sessionId))).toContain("from-notes");

    const listedAfterGrow = await harness.client.listSessions({ cwd: harness.workspace });
    expect(
      listedAfterGrow.sessions.find((session) => session.sessionId === sessionId)?.additionalDirectories,
    ).toEqual([...roots, realpathSync(notes)]);

    const cleared = await harness.client.resumeSession({
      sessionId,
      cwd: harness.workspace,
      mcpServers: [],
      additionalDirectories: [],
    });
    expect(piMeta(cleared).additionalDirectories).toEqual([]);
    expect(piMeta(cleared).additionalDirectoriesEnforced).toBe(true);
    await turn(sessionId, fauxToolCall("read", { path: join(lib, "a.txt") }));
    expect(failedTools(sessionId)).toContain("outside the session workspace");
    const listedAfterClear = await harness.client.listSessions({ cwd: harness.workspace });
    expect(
      listedAfterClear.sessions.find((session) => session.sessionId === sessionId)?.additionalDirectories,
    ).toEqual([]);
  });

  it("keeps legacy access when additionalDirectories is omitted", async () => {
    harness = await Harness.create();
    await harness.initialize();
    const outside = join(harness.root, "outside");
    const notes = join(harness.root, "notes");
    mkdirSync(outside, { recursive: true });
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    writeFileSync(join(notes, "c.txt"), "from-notes\n");
    const created = await harness.client.newSession({ cwd: harness.workspace, mcpServers: [] });
    expect(piMeta(created).additionalDirectories).toEqual([]);
    expect(piMeta(created).additionalDirectoriesEnforced).toBe(false);

    await turn(created.sessionId, fauxToolCall("read", { path: join(outside, "secret.txt") }));
    expect(JSON.stringify(harness.updatesFor(created.sessionId))).toContain("secret\\n");
    await turn(created.sessionId, fauxToolCall("bash", { command: 'echo "see /tmp"' }));
    expect(failedTools(created.sessionId)).not.toContain("outside the session workspace");
    expect(JSON.stringify(harness.updatesFor(created.sessionId))).toContain("see /tmp");

    const grown = await harness.client.extMethod("_pi/add_directory", {
      sessionId: created.sessionId,
      path: notes,
    });
    expect(grown).toEqual({ additionalDirectories: [realpathSync(notes)] });
    await turn(created.sessionId, fauxToolCall("read", { path: join(outside, "secret.txt") }));
    expect(failedTools(created.sessionId)).toContain("outside the session workspace");
    await turn(created.sessionId, fauxToolCall("read", { path: join(notes, "c.txt") }));
    expect(JSON.stringify(harness.updatesFor(created.sessionId))).toContain("from-notes");
  });

  it("does not ask a delegated client to read outside the roots", async () => {
    const reads: string[] = [];
    harness = await Harness.create({
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
      readTextFile: async (params) => {
        reads.push(params.path);
        return { content: "from-client\n" };
      },
    });
    await harness.initialize();
    const extra = join(harness.root, "extra");
    const outside = join(harness.root, "outside");
    mkdirSync(extra, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(extra, "inside.txt"), "inside\n");
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    const created = await harness.client.newSession({
      cwd: harness.workspace,
      mcpServers: [],
      additionalDirectories: [extra],
    });
    await turn(created.sessionId, fauxToolCall("read", { path: join(extra, "inside.txt") }));
    expect(reads.some((path) => path.endsWith("inside.txt"))).toBe(true);
    const before = reads.length;
    await turn(created.sessionId, fauxToolCall("read", { path: join(outside, "secret.txt") }));
    expect(reads).toHaveLength(before);
    expect(failedTools(created.sessionId)).toContain("outside the session workspace");
  });
});
