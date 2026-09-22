/**
 * E2E: OAuth login over ACP elicitation, `_auth/status_update`, capability
 * gating (boolean config options, terminal output modes), legacy set_model,
 * diff stats / file-change report, typed failures.
 */

import type { Provider } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, Harness } from "./helpers/harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** A provider whose only auth is a browser-style OAuth flow (auth_url + manual code). */
function oauthProvider(): Provider {
  const base = fauxProvider({
    provider: "faux-oauth",
    models: [{ id: "oa-1", name: "OAuth One", input: ["text"], contextWindow: 10_000 }],
  }).provider;
  return {
    ...base,
    name: "Faux OAuth",
    auth: {
      oauth: {
        name: "Faux Cloud",
        isSubscription: true,
        async login(interaction) {
          interaction.notify({
            type: "auth_url",
            url: "https://faux.example/authorize",
            instructions: "Log in",
          });
          const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
          if (code !== "good-code") throw new Error("bad code");
          return { type: "oauth", access: "tok", refresh: "ref", expires: Date.now() + 3_600_000 };
        },
        async refresh(credential) {
          return credential;
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
  };
}

describe("auth", () => {
  it("advertises oauth methods only when the client can show a URL or form", async () => {
    harness = await Harness.create({ providers: [oauthProvider()] });
    const bare = await harness.initialize();
    expect((bare.authMethods ?? []).map((m) => m.id)).not.toContain("oauth:faux-oauth");
    await harness.close();

    harness = await Harness.create({
      providers: [oauthProvider()],
      clientCapabilities: { elicitation: { url: {} } },
    });
    const withUrl = await harness.initialize();
    const method = (withUrl.authMethods ?? []).find((m) => m.id === "oauth:faux-oauth");
    expect(method).toMatchObject({
      name: "Sign in to Faux Cloud",
      _meta: { pi: { oauth: { subscription: true } } },
    });
    expect(withUrl.agentCapabilities?._meta).toMatchObject({ authStatus: {} });
  });

  it("runs an OAuth login through form elicitation and pushes _auth/status_update", async () => {
    harness = await Harness.create({
      providers: [oauthProvider()],
      clientCapabilities: { elicitation: { form: {} } },
      onElicitation: () => ({ action: "accept", content: { code: "good-code" } }),
    });
    await harness.initialize();
    await harness.settle();
    const first = harness.extNotifications.find((n) => n.method === "_auth/status_update");
    expect(first?.params).toMatchObject({ authStatus: { kind: "authenticated" } });
    const before = (first?.params as { authStatus: { providers: { providerId: string }[] } }).authStatus
      .providers;
    expect(before.map((p) => p.providerId)).not.toContain("faux-oauth");

    await harness.client.authenticate({ methodId: "oauth:faux-oauth" });
    expect(harness.elicitations[0]).toMatchObject({
      mode: "form",
      message: expect.stringContaining("https://faux.example/authorize"),
    });
    expect(typeof (harness.elicitations[0] as { requestId?: unknown }).requestId).not.toBe("undefined");
    expect(harness.modelRuntime.hasConfiguredAuth("faux-oauth")).toBe(true);
    await harness.settle();
    const after = harness.extNotifications.filter((n) => n.method === "_auth/status_update").at(-1);
    expect(after?.params).toMatchObject({
      authStatus: {
        providers: expect.arrayContaining([
          expect.objectContaining({ providerId: "faux-oauth", kind: "oauth", subscription: true }),
        ]),
      },
    });
  });

  it("opens the browser URL as a url elicitation and completes it afterwards", async () => {
    harness = await Harness.create({
      providers: [oauthProvider()],
      clientCapabilities: { elicitation: { url: {}, form: {} } },
      onElicitation: (request) =>
        request.mode === "url" ? { action: "accept" } : { action: "accept", content: { code: "good-code" } },
    });
    await harness.initialize();
    await harness.client.authenticate({ methodId: "oauth:faux-oauth" });
    const url = harness.elicitations.find((e) => e.mode === "url") as
      { elicitationId: string; url: string } | undefined;
    expect(url).toMatchObject({ url: "https://faux.example/authorize" });
    expect(harness.completedElicitations).toEqual([url?.elicitationId]);
  });

  it("reports a cancelled login as auth_required", async () => {
    harness = await Harness.create({
      providers: [oauthProvider()],
      clientCapabilities: { elicitation: { form: {} } },
      onElicitation: () => ({ action: "decline" }),
    });
    await harness.initialize();
    await expect(harness.client.authenticate({ methodId: "oauth:faux-oauth" })).rejects.toMatchObject({
      code: -32000,
    });
  });
});

describe("capability gating", () => {
  it("degrades boolean config options to selects without the boolean capability", async () => {
    harness = await Harness.create();
    await harness.initialize();
    const created = await harness.client.newSession({ cwd: harness.workspace, mcpServers: [] });
    const option = created.configOptions?.find((o) => o.id === "auto_compaction");
    expect(option).toMatchObject({ type: "select", currentValue: "on" });
    const updated = await harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: "auto_compaction",
      value: "off",
    });
    expect(updated.configOptions.find((o) => o.id === "auto_compaction")).toMatchObject({
      currentValue: "off",
    });
    await harness.close();

    harness = await Harness.create({ clientCapabilities: { session: { configOptions: { boolean: {} } } } });
    await harness.initialize();
    const typed = await harness.client.newSession({ cwd: harness.workspace, mcpServers: [] });
    expect(typed.configOptions?.find((o) => o.id === "auto_compaction")).toMatchObject({
      type: "boolean",
      currentValue: true,
    });
  });

  it("uses terminal_output_delta when the client asks for it", async () => {
    harness = await Harness.create({
      clientCapabilities: { _meta: { terminal_output_delta: true } },
    });
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo delta-mode" })]),
      fauxAssistantMessage("ok"),
    );
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "run" }] });
    const updates = harness.updatesFor(sessionId);
    expect(
      updates.some(
        (u) => u.sessionUpdate === "tool_call" && JSON.stringify(u._meta).includes("terminal_info"),
      ),
    ).toBe(true);
    const outputs = updates.filter(
      (u) =>
        u.sessionUpdate === "tool_call_update" &&
        (u._meta as Record<string, unknown> | undefined)?.["terminal_output_delta"] !== undefined,
    );
    expect(JSON.stringify(outputs)).toContain("delta-mode");
    expect(
      updates.some(
        (u) => (u._meta as Record<string, unknown> | undefined)?.["terminal_output"] !== undefined,
      ),
    ).toBe(false);
  });

  it("supports the legacy session/set_model extension method", async () => {
    harness = await Harness.create();
    await harness.initialize();
    const sessionId = await harness.newSession();
    await harness.client.extMethod("session/set_model", { sessionId, modelId: "faux/faux-2" });
    await harness.settle();
    const update = harness
      .updatesFor(sessionId)
      .filter((u) => u.sessionUpdate === "config_option_update")
      .at(-1);
    expect(
      update?.sessionUpdate === "config_option_update" && update.configOptions.find((o) => o.id === "model"),
    ).toMatchObject({ currentValue: "faux/faux-2" });
  });
});

describe("file changes and failures", () => {
  it("annotates diffs with stats and reports per-turn file changes", async () => {
    harness = await Harness.create();
    await harness.initialize();
    const sessionId = await harness.newSession();
    const file = join(harness.workspace, "a.txt");
    writeFileSync(file, "one\ntwo\n");
    harness.respond(
      fauxAssistantMessage([
        fauxToolCall("edit", { path: "a.txt", edits: [{ oldText: "two", newText: "2\n3" }] }),
        fauxToolCall("write", { path: "b.txt", content: "new\nfile\n" }),
      ]),
      fauxAssistantMessage("done"),
    );
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "edit" }] });
    expect(readFileSync(file, "utf8")).toBe("one\n2\n3\n");
    const diffs = harness
      .updatesFor(sessionId)
      .filter((u) => u.sessionUpdate === "tool_call_update" && u.content?.some((c) => c.type === "diff"))
      .flatMap((u) => (u.sessionUpdate === "tool_call_update" ? (u.content ?? []) : []))
      .sort((a, b) => (a.type === "diff" && b.type === "diff" ? a.path.localeCompare(b.path) : 0));
    expect(diffs[0]).toMatchObject({
      type: "diff",
      path: file,
      _meta: { pi: { fileChange: "update", diffStats: { added: 2, removed: 1 } } },
    });
    expect(diffs[1]).toMatchObject({
      type: "diff",
      _meta: { pi: { fileChange: "add", diffStats: { added: 2, removed: 0 } } },
    });
    const report = harness
      .updatesFor(sessionId)
      .find(
        (u) =>
          u.sessionUpdate === "session_info_update" &&
          (u._meta as { pi?: { event?: string } } | undefined)?.pi?.event === "file_changes",
      );
    const files = (report?._meta as { pi: { files: { path: string }[] } }).pi.files.sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    expect(files).toEqual([
      { path: file, kind: "update", added: 2, removed: 1 },
      { path: join(harness.workspace, "b.txt"), kind: "add", added: 2, removed: 0 },
    ]);
  });

  it("emits a typed failure notice when the model call fails", async () => {
    harness = await Harness.create();
    await harness.initialize();
    const sessionId = await harness.newSession();
    // Not retryable by pi (no 429/overloaded wording), so the turn fails immediately.
    harness.respond(
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "upstream 502 Bad Gateway" }),
    );
    await expect(
      harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] }),
    ).rejects.toMatchObject({
      data: { pi: { failure: "provider_error" } },
    });
    const notice = harness
      .updatesFor(sessionId)
      .find(
        (u) =>
          u.sessionUpdate === "session_info_update" &&
          (u._meta as { pi?: { event?: string } } | undefined)?.pi?.event === "failure",
      );
    expect(notice?._meta).toMatchObject({ pi: { kind: "provider_error" } });
  });
});
