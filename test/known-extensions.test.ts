/**
 * E2E: known third-party extensions surfaced as first-class ACP features.
 * Fixtures reproduce each extension's documented wire shapes (tool results,
 * session entries, event API) so the adapter is tested against the contract
 * it adapts, without installing the packages.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, Harness } from "./helpers/harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** @juicesharp/rpiv-todo: `todo` tool, full task snapshot in every result's details. */
const RPIV_TODO = `
import { Type } from "typebox";
export default function (pi) {
  let tasks = []; let nextId = 1;
  pi.registerTool({
    name: "todo", label: "Todo", description: "task list",
    parameters: Type.Object({ action: Type.String(), subject: Type.Optional(Type.String()), id: Type.Optional(Type.Number()), status: Type.Optional(Type.String()), activeForm: Type.Optional(Type.String()) }),
    async execute(_id, p) {
      if (p.action === "create") tasks.push({ id: nextId++, subject: p.subject, status: "pending" });
      if (p.action === "update") { const t = tasks.find((t) => t.id === p.id); if (t) { t.status = p.status; if (p.activeForm) t.activeForm = p.activeForm; } }
      if (p.action === "delete") { const t = tasks.find((t) => t.id === p.id); if (t) t.status = "deleted"; }
      // Like the real reducer, every result carries its own immutable snapshot.
      return { content: [{ type: "text", text: "ok" }], details: { action: p.action, params: p, tasks: tasks.map((t) => ({ ...t })), nextId } };
    },
  });
}
`;

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

/** @plannotator/pi-extension: phases via `plannotator:request`, state entries, submit/mark-done tools. */
const PLANNOTATOR = `
import { Type } from "typebox";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
export default function (pi) {
  let phase = "idle"; let lastSubmittedPath = null;
  const persist = () => pi.appendEntry("plannotator", { phase, lastSubmittedPath });
  pi.on("session_start", (_e, ctx) => {
    for (const e of ctx.sessionManager.getBranch()) if (e.type === "custom" && e.customType === "plannotator") { phase = e.data.phase; lastSubmittedPath = e.data.lastSubmittedPath; }
  });
  pi.events.on("plannotator:request", async (req) => {
    if (req.action !== "plan-mode") return;
    const mode = req.payload?.mode ?? "toggle";
    if (mode === "enter" && phase === "idle") { phase = "planning"; persist(); }
    else if (mode === "exit" && phase !== "idle") { phase = "idle"; persist(); }
    else if (mode === "toggle") { phase = phase === "idle" ? "planning" : "idle"; persist(); }
    req.respond({ status: "handled", result: { phase } });
  });
  pi.registerTool({ name: "plannotator_submit_plan", description: "submit", parameters: Type.Object({ filePath: Type.String() }),
    async execute(_id, p, _s, _u, ctx) {
      lastSubmittedPath = p.filePath; phase = "executing";
      pi.appendEntry("plannotator-execute", { lastSubmittedPath }); persist();
      return { content: [{ type: "text", text: "approved" }], details: { approved: true } };
    } });
  pi.registerTool({ name: "plannotator_mark_done", description: "done", parameters: Type.Object({ step: Type.Number() }),
    async execute(_id, p, _s, _u, ctx) {
      const path = resolve(ctx.cwd, lastSubmittedPath); let n = 0;
      writeFileSync(path, readFileSync(path, "utf8").replace(/^([-*] )\\[ \\]/gm, (m, b) => (++n === p.step ? b + "[x]" : m)));
      persist();
      return { content: [{ type: "text", text: "done" }], details: { completed: true, step: p.step } };
    } });
}
`;

function installExtension(h: Harness, file: string, source: string): string {
  const dir = join(h.agentDir, "extensions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, source);
  return path;
}

function plans(h: Harness, sessionId: string) {
  return h.updatesFor(sessionId).filter((u) => u.sessionUpdate === "plan");
}

describe("rpiv-todo → plan", () => {
  it("projects every todo snapshot as an ACP plan and replays the last one on load", async () => {
    harness = await Harness.create({ settings: { permissionMode: "full-access" } });
    installExtension(harness, "rpiv-todo.js", RPIV_TODO);
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(
      fauxAssistantMessage([
        fauxToolCall("todo", { action: "create", subject: "Research" }),
        fauxToolCall("todo", { action: "create", subject: "Implement" }),
      ]),
      fauxAssistantMessage([
        fauxToolCall("todo", { action: "update", id: 1, status: "in_progress", activeForm: "reading code" }),
      ]),
      fauxAssistantMessage([fauxToolCall("todo", { action: "delete", id: 2 })]),
      fauxAssistantMessage("ok"),
    );
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "plan it" }] });
    const seen = plans(harness, sessionId).map((u) => (u.sessionUpdate === "plan" ? u.entries : []));
    expect(seen).toEqual([
      [{ content: "Research", status: "pending", priority: "medium" }],
      [
        { content: "Research", status: "pending", priority: "medium" },
        { content: "Implement", status: "pending", priority: "medium" },
      ],
      [
        { content: "Research — reading code", status: "in_progress", priority: "medium" },
        { content: "Implement", status: "pending", priority: "medium" },
      ],
      [{ content: "Research — reading code", status: "in_progress", priority: "medium" }],
    ]);

    await harness.client.closeSession({ sessionId });
    harness.notifications.length = 0;
    await harness.client.loadSession({ sessionId, cwd: harness.workspace, mcpServers: [] });
    await harness.settle();
    expect(plans(harness, sessionId)).toEqual([
      {
        sessionUpdate: "plan",
        entries: [{ content: "Research — reading code", status: "in_progress", priority: "medium" }],
      },
    ]);
  });

  it("does nothing for an unrelated tool named todo without the package", async () => {
    harness = await Harness.create({ settings: { permissionMode: "full-access" } });
    installExtension(harness, "my-notes.js", RPIV_TODO);
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(
      fauxAssistantMessage([fauxToolCall("todo", { action: "create", subject: "x" })]),
      fauxAssistantMessage("ok"),
    );
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
    expect(plans(harness, sessionId)).toEqual([]);
  });
});

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

describe("plannotator → collaboration mode + plan", () => {
  it("exposes collaboration_mode, /plan, and the executing checklist as a plan", async () => {
    harness = await Harness.create({ settings: { permissionMode: "full-access" } });
    installExtension(harness, "plannotator.js", PLANNOTATOR);
    await harness.initialize();
    const created = await harness.client.newSession({ cwd: harness.workspace, mcpServers: [] });
    const sessionId = created.sessionId;
    expect(created.configOptions?.find((o) => o.id === "collaboration_mode")).toMatchObject({
      currentValue: "default",
    });
    await harness.settle();
    const commands = harness
      .updatesFor(sessionId)
      .filter((u) => u.sessionUpdate === "available_commands_update")
      .at(-1);
    expect(
      commands?.sessionUpdate === "available_commands_update" && commands.availableCommands[0],
    ).toMatchObject({
      name: "plan",
      _meta: { commandAction: { kind: "setConfigOption", configId: "collaboration_mode", value: "plan" } },
    });

    const on = await harness.client.setSessionConfigOption({
      sessionId,
      configId: "collaboration_mode",
      value: "plan",
    });
    expect(on.configOptions.find((o) => o.id === "collaboration_mode")).toMatchObject({
      currentValue: "plan",
    });
    const off = await harness.client.setSessionConfigOption({
      sessionId,
      configId: "collaboration_mode",
      value: "default",
    });
    expect(off.configOptions.find((o) => o.id === "collaboration_mode")).toMatchObject({
      currentValue: "default",
    });
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "/plan" }] });
    expect(harness.text(sessionId)).toContain("Plan mode on");

    writeFileSync(join(harness.workspace, "PLAN.md"), "# Plan\n\n- [ ] Write tests\n- [ ] Ship it\n");
    harness.respond(
      fauxAssistantMessage([fauxToolCall("plannotator_submit_plan", { filePath: "PLAN.md" })]),
      fauxAssistantMessage([fauxToolCall("plannotator_mark_done", { step: 1 })]),
      fauxAssistantMessage("ok"),
    );
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
    const seen = plans(harness, sessionId).map((u) => (u.sessionUpdate === "plan" ? u.entries : []));
    expect(seen).toEqual([
      [
        { content: "Write tests", status: "pending", priority: "medium" },
        { content: "Ship it", status: "pending", priority: "medium" },
      ],
      [
        { content: "Write tests", status: "completed", priority: "medium" },
        { content: "Ship it", status: "pending", priority: "medium" },
      ],
    ]);
    expect(readFileSync(join(harness.workspace, "PLAN.md"), "utf8")).toContain("- [x] Write tests");
    const options = harness
      .updatesFor(sessionId)
      .filter((u) => u.sessionUpdate === "config_option_update")
      .at(-1);
    expect(
      options?.sessionUpdate === "config_option_update" &&
        options.configOptions.find((o) => o.id === "collaboration_mode"),
    ).toMatchObject({ currentValue: "default" });
  });
});
