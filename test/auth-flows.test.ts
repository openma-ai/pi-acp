/**
 * Issue #9 e2e: typed auth commands never reach the model (auth_required +
 * data.authMethods); authenticate covers _meta api-key, gateway, URL-elicitation
 * loopback, terminal-method rejection; logout is scoped and reports cleared.
 */

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keyableProvider } from "./helpers/auth-providers.ts";
import { Harness } from "./helpers/harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const AUTH_REQUIRED = -32000;
const INVALID_PARAMS = -32602;

async function submit(url: string) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "apiKey=good-key",
  });
}

describe("advertised auth methods", () => {
  it('gates the terminal method on auth.terminal / _meta["terminal-auth"]', async () => {
    harness = await Harness.create();
    const bare = await harness.initialize();
    expect((bare.authMethods ?? []).map((m) => m.id)).not.toContain("pi-terminal-login");
    await harness.close();

    harness = await Harness.create({ clientCapabilities: { auth: { terminal: true } } });
    const spec = await harness.initialize();
    const method = (spec.authMethods ?? []).find((m) => m.id === "pi-terminal-login");
    expect(method).toMatchObject({ type: "terminal", args: ["--terminal-login"], env: {} });
    await harness.close();

    harness = await Harness.create({ clientCapabilities: { _meta: { "terminal-auth": true } } });
    const meta = await harness.initialize();
    const launch = (meta.authMethods ?? []).find((m) => m.id === "pi-terminal-login")?._meta;
    expect(launch).toMatchObject({
      "terminal-auth": {
        args: expect.arrayContaining(["--terminal-login"]),
        label: expect.any(String),
      },
    });
  });

  it("gates the gateway method on auth._meta.gateway", async () => {
    harness = await Harness.create({ clientCapabilities: { auth: { terminal: true } } });
    const bare = await harness.initialize();
    expect((bare.authMethods ?? []).map((m) => m.id)).not.toContain("gateway");
    await harness.close();

    harness = await Harness.create({
      clientCapabilities: { auth: { terminal: true, _meta: { gateway: true } } },
    });
    const response = await harness.initialize();
    expect((response.authMethods ?? []).find((m) => m.id === "gateway")).toMatchObject({
      _meta: { gateway: { protocol: "openai-completions" } },
    });
  });
});

describe("typed auth commands", () => {
  it("never advertises /login or /logout and never sends them to the model", async () => {
    harness = await Harness.create();
    await harness.initialize();
    const sessionId = await harness.newSession();
    await harness.settle();
    const commands = harness
      .updatesFor(sessionId)
      .find((u) => u.sessionUpdate === "available_commands_update");
    expect(
      commands?.sessionUpdate === "available_commands_update"
        ? commands.availableCommands.map((c) => c.name)
        : [],
    ).not.toEqual(expect.arrayContaining(["login", "logout"]));

    for (const text of ["/login", "/logout", "/login anthropic"]) {
      harness.respond(fauxAssistantMessage("must not be used"));
      await expect(
        harness.client.prompt({ sessionId, prompt: [{ type: "text", text }] }),
      ).rejects.toMatchObject({
        code: AUTH_REQUIRED,
        data: { authMethods: expect.arrayContaining([expect.objectContaining({ id: "api-key:faux" })]) },
      });
    }
    // Three typed commands, zero model calls.
    expect(harness.faux.state.callCount).toBe(0);
  });

  it("does not parse-slash when the prompt carries an image", async () => {
    harness = await Harness.create();
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(fauxAssistantMessage("saw it"));
    await harness.client.prompt({
      sessionId,
      prompt: [
        { type: "text", text: "/login" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ],
    });
    expect(harness.faux.state.callCount).toBe(1);
  });

  it("attaches authMethods to a provider 401 during a normal turn", async () => {
    harness = await Harness.create();
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 unauthorized: bad key" }),
    );
    await expect(
      harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toMatchObject({
      code: AUTH_REQUIRED,
      data: { authMethods: expect.any(Array) },
    });
  });
});

describe("authenticate", () => {
  it("rejects the terminal method id with a clear error", async () => {
    harness = await Harness.create({ clientCapabilities: { auth: { terminal: true } } });
    await harness.initialize();
    await expect(harness.client.authenticate({ methodId: "pi-terminal-login" })).rejects.toMatchObject({
      code: INVALID_PARAMS,
      message: expect.stringContaining("--terminal-login"),
    });
  });

  it('stores an _meta["api-key"] key and reports the active account', async () => {
    harness = await Harness.create({ providers: [keyableProvider()] });
    await harness.initialize();
    const result = await harness.client.authenticate({
      methodId: "api-key:keyable",
      _meta: { "api-key": { apiKey: "good-key" } },
    });
    expect(result._meta).toMatchObject({
      pi: { auth: { provider: "keyable", kind: "api_key" }, authStatus: { kind: "authenticated" } },
    });
    expect(harness.modelRuntime.hasConfiguredAuth("keyable")).toBe(true);
  });

  it("re-authenticating the same provider overwrites; a second provider adds", async () => {
    harness = await Harness.create({ providers: [keyableProvider(), keyableProvider("other")] });
    await harness.initialize();
    await harness.client.authenticate({
      methodId: "api-key:keyable",
      _meta: { "api-key": { apiKey: "good-key" } },
    });
    const again = await harness.client.authenticate({
      methodId: "api-key:keyable",
      _meta: { "api-key": { apiKey: "good-key" } },
    });
    expect(again._meta).toMatchObject({ pi: { auth: { provider: "keyable" } } });
    const other = await harness.client.authenticate({
      methodId: "api-key:other",
      _meta: { "api-key": { apiKey: "good-key", provider: "other" } },
    });
    expect(other._meta).toMatchObject({
      pi: { auth: { provider: "other", kind: "api_key" }, authStatus: { kind: "authenticated" } },
    });
    const meta = other._meta as { pi?: { authStatus?: { providers?: { providerId: string }[] } } };
    const providers = (meta.pi?.authStatus?.providers ?? []).map((p) => p.providerId);
    expect(providers).toEqual(expect.arrayContaining(["keyable", "other"]));
  });

  it("reports the already-configured provider when no new key is sent", async () => {
    harness = await Harness.create({ providers: [keyableProvider()] });
    await harness.initialize();
    await harness.client.authenticate({
      methodId: "api-key:keyable",
      _meta: { "api-key": { apiKey: "good-key" } },
    });
    const result = await harness.client.authenticate({ methodId: "api-key:keyable" });
    expect(result._meta).toMatchObject({ pi: { auth: { provider: "keyable", kind: "api_key" } } });
  });

  it("rejects unknown methods and api-key without a secret path, naming the alternatives", async () => {
    harness = await Harness.create({ providers: [keyableProvider()] });
    await harness.initialize();
    await expect(harness.client.authenticate({ methodId: "bogus" })).rejects.toMatchObject({
      code: INVALID_PARAMS,
    });
    await expect(harness.client.authenticate({ methodId: "api-key:keyable" })).rejects.toMatchObject({
      code: AUTH_REQUIRED,
      message: expect.stringContaining('_meta["api-key"]'),
      data: { authMethods: expect.any(Array) },
    });
    await expect(harness.client.authenticate({ methodId: "api-key:keyable" })).rejects.toMatchObject({
      message: expect.stringContaining("URL elicitation"),
    });
  });

  it("falls back to a runtime-only key when the provider cannot persist one", async () => {
    harness = await Harness.create();
    await harness.initialize();
    // faux's apiKey auth has no `login` implementation, so the store path fails
    // and the key lands on the runtime (documented fallback, cleared by logout).
    const result = await harness.client.authenticate({
      methodId: "api-key:faux",
      _meta: { "api-key": { apiKey: "sk-runtime" } },
    });
    expect(result._meta).toMatchObject({ pi: { auth: { provider: "faux", kind: "api_key" } } });
    const out = await harness.client.logout({ _meta: { pi: { logout: { provider: "faux" } } } });
    expect(out._meta).toMatchObject({ pi: { logout: { cleared: ["faux"] } } });
  });

  it('honours _meta["api-key"].provider even on an unrelated methodId', async () => {
    harness = await Harness.create({ providers: [keyableProvider()] });
    await harness.initialize();
    const result = await harness.client.authenticate({
      methodId: "bogus",
      _meta: { "api-key": { apiKey: "good-key", provider: "keyable" } },
    });
    expect(result._meta).toMatchObject({ pi: { auth: { provider: "keyable", kind: "api_key" } } });
    expect(harness.modelRuntime.hasConfiguredAuth("keyable")).toBe(true);
  });

  it("surfaces an internal error when the URL path has no request id", async () => {
    harness = await Harness.create({
      providers: [keyableProvider()],
      clientCapabilities: { elicitation: { url: {} } },
      wireRequestIds: false,
    });
    await harness.initialize();
    await expect(harness.client.authenticate({ methodId: "api-key:keyable" })).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("request id"),
    });
  });
});

describe("URL-elicitation api-key path", () => {
  it("captures the key through a loopback page opened by a url elicitation", async () => {
    harness = await Harness.create({
      providers: [keyableProvider()],
      clientCapabilities: { elicitation: { url: {} } },
      onElicitation: async (request) => {
        expect(request.mode).toBe("url");
        const url = (request as { url: string }).url;
        const page = await fetch(url);
        expect(await page.text()).toContain("API key");
        const posted = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "apiKey=good-key",
        });
        expect(posted.status).toBe(200);
        return { action: "accept" };
      },
    });
    await harness.initialize();
    const result = await harness.client.authenticate({ methodId: "api-key:keyable" });
    expect(result._meta).toMatchObject({ pi: { auth: { provider: "keyable", kind: "api_key" } } });
    expect(harness.modelRuntime.hasConfiguredAuth("keyable")).toBe(true);
    expect(harness.completedElicitations.length).toBe(1);
  });

  it("aborts the key capture on the auth-flow timeout", async () => {
    vi.useFakeTimers();
    try {
      harness = await Harness.create({
        providers: [keyableProvider()],
        clientCapabilities: { elicitation: { url: {} } },
        onElicitation: () => new Promise(() => undefined), // never resolves
      });
      await harness.initialize();
      const attempt = harness.client.authenticate({ methodId: "api-key:keyable" });
      attempt.catch(() => undefined); // attached early; asserted below
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      await expect(attempt).rejects.toMatchObject({
        code: AUTH_REQUIRED,
        message: expect.stringContaining("cancelled"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps a declined elicitation to auth_required", async () => {
    harness = await Harness.create({
      providers: [keyableProvider()],
      clientCapabilities: { elicitation: { url: {} } },
      onElicitation: () => ({ action: "decline" }),
    });
    await harness.initialize();
    await expect(harness.client.authenticate({ methodId: "api-key:keyable" })).rejects.toMatchObject({
      code: AUTH_REQUIRED,
      data: { authMethods: expect.any(Array) },
    });
  });

  it("maps an elicitation transport failure to auth_required", async () => {
    harness = await Harness.create({
      providers: [keyableProvider()],
      clientCapabilities: { elicitation: { url: {} } },
      onElicitation: () => {
        throw new Error("wire down");
      },
    });
    await harness.initialize();
    await expect(harness.client.authenticate({ methodId: "api-key:keyable" })).rejects.toMatchObject({
      code: AUTH_REQUIRED,
      message: expect.stringContaining("login with Keyable failed"),
      data: { authMethods: expect.any(Array) },
    });
  });

  it("keys the page by provider id when the provider is not in the registry", async () => {
    harness = await Harness.create({
      providers: [keyableProvider()],
      clientCapabilities: { elicitation: { url: {} } },
      onElicitation: async (request) => {
        const url = (request as { url: string }).url;
        expect(await (await fetch(url)).text()).toContain("zzz-unknown");
        await submit(url);
        return { action: "accept" };
      },
    });
    await harness.initialize();
    const result = await harness.client.authenticate({ methodId: "api-key:zzz-unknown" });
    expect(result._meta).toMatchObject({ pi: { auth: { provider: "zzz-unknown" } } });
  });
});

describe("gateway auth", () => {
  it("writes models.json from _meta.gateway and authenticates the provider", async () => {
    harness = await Harness.create({
      clientCapabilities: { auth: { terminal: true, _meta: { gateway: true } } },
    });
    await harness.initialize();
    const result = await harness.client.authenticate({
      methodId: "gateway",
      _meta: {
        gateway: {
          baseUrl: "https://gw.example.com/v1",
          headers: { Authorization: "Bearer sk-gw", "X-Team": "eng" },
          providerName: "My GW",
          models: [{ id: "gw-1" }],
        },
      },
    });
    expect(result._meta).toMatchObject({ pi: { auth: { provider: "my-gw", kind: "gateway" } } });
    const doc = JSON.parse(readFileSync(join(harness.agentDir, "models.json"), "utf8")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    expect(doc.providers["my-gw"]).toMatchObject({
      name: "My GW",
      baseUrl: "https://gw.example.com/v1",
      api: "openai-completions",
      apiKey: "sk-gw",
      headers: { "X-Team": "eng" },
      models: [{ id: "gw-1" }],
    });
    expect(harness.modelRuntime.hasConfiguredAuth("my-gw")).toBe(true);
  });

  it("rejects malformed _meta.gateway payloads", async () => {
    harness = await Harness.create();
    await harness.initialize();
    for (const meta of [undefined, { gateway: { headers: {} } }, { gateway: { baseUrl: 42 } }]) {
      await expect(
        harness.client.authenticate({ methodId: "gateway", _meta: meta as never }),
      ).rejects.toMatchObject({ code: INVALID_PARAMS });
    }
  });

  it("merges into an existing models.json, preserving other providers and keys", async () => {
    harness = await Harness.create({
      clientCapabilities: { auth: { _meta: { gateway: true } } },
    });
    await harness.initialize();
    writeFileSync(
      join(harness.agentDir, "models.json"),
      JSON.stringify({
        top: "preserved",
        providers: {
          gw: { name: "Old", baseUrl: "https://old", apiKey: "old", extra: { keep: 1 } },
          other: { apiKey: "stays" },
          nonobj: 7,
        },
      }),
    );
    await harness.client.authenticate({
      methodId: "gateway",
      _meta: { gateway: { baseUrl: "https://new", providerName: "gw" } },
    });
    const doc = JSON.parse(readFileSync(join(harness.agentDir, "models.json"), "utf8")) as {
      top: string;
      providers: Record<string, Record<string, unknown>>;
    };
    expect(doc.top).toBe("preserved");
    expect(doc.providers["gw"]).toMatchObject({
      baseUrl: "https://new",
      apiKey: "old",
      extra: { keep: 1 },
    });
    expect(doc.providers["other"]).toEqual({ apiKey: "stays" });
    // Overwriting a non-object provider entry still works.
    await harness.client.authenticate({
      methodId: "gateway",
      _meta: { gateway: { baseUrl: "https://n2", providerName: "nonobj" } },
    });
    const after = JSON.parse(readFileSync(join(harness.agentDir, "models.json"), "utf8")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    expect(after.providers["nonobj"]).toMatchObject({ baseUrl: "https://n2" });
  });

  it("rejects when models.json cannot be parsed, is not an object, or cannot be written", async () => {
    harness = await Harness.create({
      clientCapabilities: { auth: { _meta: { gateway: true } } },
    });
    await harness.initialize();
    const path = join(harness.agentDir, "models.json");
    const meta = { gateway: { baseUrl: "https://gw.example.com" } };
    writeFileSync(path, "garbage{");
    await expect(harness.client.authenticate({ methodId: "gateway", _meta: meta })).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("cannot parse"),
    });
    writeFileSync(path, "[]");
    await expect(harness.client.authenticate({ methodId: "gateway", _meta: meta })).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("JSON object"),
    });
    rmSync(path);
    chmodSync(harness.agentDir, 0o555);
    try {
      await expect(harness.client.authenticate({ methodId: "gateway", _meta: meta })).rejects.toMatchObject({
        code: -32603,
        message: expect.stringContaining("cannot write"),
      });
    } finally {
      chmodSync(harness.agentDir, 0o755);
    }
  });
});

describe("logout", () => {
  async function authed(model: string | undefined) {
    harness = await Harness.create({
      providers: [keyableProvider(), keyableProvider("other")],
      settings: { model },
      clientCapabilities: { auth: { terminal: true, _meta: { gateway: true } } },
    });
    await harness.initialize();
    await harness.client.authenticate({
      methodId: "api-key:keyable",
      _meta: { "api-key": { apiKey: "good-key" } },
    });
    await harness.client.authenticate({
      methodId: "api-key:other",
      _meta: { "api-key": { apiKey: "good-key" } },
    });
    await harness.client.authenticate({
      methodId: "gateway",
      _meta: { gateway: { baseUrl: "https://gw.example.com", headers: { "x-api-key": "k" } } },
    });
    return harness;
  }

  it("scopes logout to one provider by default (the configured model's provider)", async () => {
    const h = await authed("keyable/keyable-1");
    const result = await h.client.logout({});
    expect(result._meta).toMatchObject({ pi: { logout: { cleared: ["keyable"] } } });
    expect(h.modelRuntime.hasConfiguredAuth("keyable")).toBe(false);
    expect(h.modelRuntime.hasConfiguredAuth("other")).toBe(true);
    expect(h.modelRuntime.hasConfiguredAuth("gateway")).toBe(true);
  });

  it("scopes logout to _meta.pi.logout.provider, including gateway providers", async () => {
    const h = await authed("keyable/keyable-1");
    const result = await h.client.logout({ _meta: { pi: { logout: { provider: "gateway" } } } });
    expect(result._meta).toMatchObject({ pi: { logout: { cleared: ["gateway"] } } });
    const doc = JSON.parse(readFileSync(join(h.agentDir, "models.json"), "utf8")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    expect(doc.providers["gateway"]).not.toHaveProperty("apiKey");
    expect(h.modelRuntime.hasConfiguredAuth("gateway")).toBe(false);
    expect(h.modelRuntime.hasConfiguredAuth("keyable")).toBe(true);
  });

  it("clears everything only for an explicit all:true scope", async () => {
    const h = await authed("keyable/keyable-1");
    const result = await h.client.logout({ _meta: { pi: { logout: { all: true } } } });
    const meta = result._meta as { pi?: { logout?: { cleared?: string[] } } };
    const cleared = meta.pi?.logout?.cleared ?? [];
    expect(cleared.sort()).toEqual(["gateway", "keyable", "other"]);
    expect(h.modelRuntime.hasConfiguredAuth("keyable")).toBe(false);
    expect(h.modelRuntime.hasConfiguredAuth("other")).toBe(false);
  });

  it("errors with the signed-in list when a bare logout is ambiguous", async () => {
    const h = await authed(undefined);
    await expect(h.client.logout({})).rejects.toMatchObject({
      code: INVALID_PARAMS,
      message: expect.stringContaining("_meta.pi.logout"),
    });
  });

  it("names no providers when a bare logout is ambiguous and nothing is signed in", async () => {
    harness = await Harness.create({ providers: [keyableProvider()], settings: { model: undefined } });
    await harness.initialize();
    await expect(harness.client.logout({})).rejects.toMatchObject({
      code: INVALID_PARAMS,
      message: expect.not.stringContaining("signed in"),
    });
  });

  it("reports cleared: [] for a provider that was never authenticated", async () => {
    const h = await authed("keyable/keyable-1");
    const result = await h.client.logout({ _meta: { pi: { logout: { provider: "mistral" } } } });
    expect(result._meta).toMatchObject({ pi: { logout: { cleared: [] } } });
  });

  it("falls back to the only removable provider when no model is configured", async () => {
    harness = await Harness.create({
      providers: [keyableProvider()],
      settings: { model: undefined },
    });
    await harness.initialize();
    await harness.client.authenticate({
      methodId: "api-key:keyable",
      _meta: { "api-key": { apiKey: "good-key" } },
    });
    const result = await harness.client.logout({});
    expect(result._meta).toMatchObject({ pi: { logout: { cleared: ["keyable"] } } });
  });

  function modelsJsonDoc(h: Harness, doc: string) {
    writeFileSync(join(h.agentDir, "models.json"), doc);
    return join(h.agentDir, "models.json");
  }

  it("ignores malformed or oddly-shaped models.json during logout", async () => {
    harness = await Harness.create({ providers: [keyableProvider()] });
    await harness.initialize();
    await harness.client.authenticate({
      methodId: "api-key:keyable",
      _meta: { "api-key": { apiKey: "good-key" } },
    });
    modelsJsonDoc(harness, "not json{");
    const bad = await harness.client.logout({ _meta: { pi: { logout: { provider: "keyable" } } } });
    expect(bad._meta).toMatchObject({ pi: { logout: { cleared: ["keyable"] } } });

    for (const doc of [
      '{"providers":5}',
      '{"providers":{"gw":7}}',
      "{}",
      '{"providers":null}',
      '{"providers":{"bare":{"name":"n"}}}',
    ]) {
      modelsJsonDoc(harness, doc);
      const result = await harness.client.logout({ _meta: { pi: { logout: { all: true } } } });
      const meta = result._meta as { pi: { logout: { cleared: string[] } } };
      expect(Array.isArray(meta.pi.logout.cleared)).toBe(true);
      const scoped = await harness.client.logout({
        _meta: { pi: { logout: { provider: "gw" } } },
      });
      expect(scoped._meta).toMatchObject({ pi: { logout: { cleared: [] } } });
    }
  });

  it("scrubs apiKey and auth headers but keeps the provider and other keys", async () => {
    harness = await Harness.create({ providers: [keyableProvider()] });
    await harness.initialize();
    modelsJsonDoc(
      harness,
      JSON.stringify({
        providers: {
          gw: {
            name: "GW",
            baseUrl: "https://gw.example.com",
            api: "openai-completions",
            apiKey: "sk",
            headers: { Authorization: "Bearer sk", "X-Team": "eng" },
          },
          other: { name: "Other", baseUrl: "https://o.example.com", headers: { "x-api-key": "k" } },
        },
      }),
    );
    const result = await harness.client.logout({ _meta: { pi: { logout: { provider: "gw" } } } });
    expect(result._meta).toMatchObject({ pi: { logout: { cleared: ["gw"] } } });
    const doc = JSON.parse(readFileSync(join(harness.agentDir, "models.json"), "utf8")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    expect(doc.providers["gw"]).toMatchObject({
      name: "GW",
      baseUrl: "https://gw.example.com",
      headers: { "X-Team": "eng" },
    });
    expect(doc.providers["gw"]).not.toHaveProperty("apiKey");
    // Scoped: the other provider's credential is untouched.
    expect(doc.providers["other"]?.["headers"]).toEqual({ "x-api-key": "k" });
    // An entry with nothing but auth headers loses the headers key entirely.
    await harness.client.logout({ _meta: { pi: { logout: { provider: "other" } } } });
    const after = JSON.parse(readFileSync(join(harness.agentDir, "models.json"), "utf8")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    expect(after.providers["other"]).toEqual({ name: "Other", baseUrl: "https://o.example.com" });
    // A second logout over the same entry clears nothing.
    const again = await harness.client.logout({ _meta: { pi: { logout: { provider: "gw" } } } });
    expect(again._meta).toMatchObject({ pi: { logout: { cleared: [] } } });
  });

  it("survives an unwritable models.json", async () => {
    harness = await Harness.create({ providers: [keyableProvider()] });
    await harness.initialize();
    const path = modelsJsonDoc(harness, JSON.stringify({ providers: { gw: { apiKey: "sk" } } }));
    chmodSync(path, 0o444);
    const result = await harness.client.logout({ _meta: { pi: { logout: { provider: "gw" } } } });
    expect(result._meta).toMatchObject({ pi: { logout: { cleared: [] } } });
  });

  it("clears runtime-only keys and headers-only providers under all:true", async () => {
    harness = await Harness.create();
    await harness.initialize();
    // faux cannot persist, so the key lands on the runtime set.
    await harness.client.authenticate({
      methodId: "api-key:faux",
      _meta: { "api-key": { apiKey: "sk-runtime" } },
    });
    modelsJsonDoc(harness, JSON.stringify({ providers: { ho: { headers: { "x-api-key": "k" } } } }));
    const result = await harness.client.logout({ _meta: { pi: { logout: { all: true } } } });
    const cleared = (result._meta as { pi?: { logout?: { cleared?: string[] } } }).pi?.logout?.cleared;
    expect(cleared?.sort()).toEqual(["faux", "ho"]);
  });

  it("keeps going when a credential removal fails", async () => {
    const h = await authed("keyable/keyable-1");
    const spy = vi.spyOn(h.modelRuntime, "logout").mockRejectedValue(new Error("store is locked"));
    const result = await h.client.logout({ _meta: { pi: { logout: { provider: "keyable" } } } });
    expect(result._meta).toMatchObject({ pi: { logout: { cleared: [] } } });
    spy.mockRestore();
    // Runtime-key removal failing does not undo the cleared flag.
    await h.client.authenticate({
      methodId: "api-key:faux",
      _meta: { "api-key": { apiKey: "sk-runtime" } },
    });
    vi.spyOn(h.modelRuntime, "removeRuntimeApiKey").mockRejectedValue(new Error("stuck"));
    const after = await h.client.logout({ _meta: { pi: { logout: { provider: "faux" } } } });
    expect(after._meta).toMatchObject({ pi: { logout: { cleared: ["faux"] } } });
  });

  it("uses settings.json defaultProvider as the logout scope", async () => {
    harness = await Harness.create({
      providers: [keyableProvider()],
      settings: { model: undefined },
    });
    await harness.initialize();
    await harness.client.authenticate({
      methodId: "api-key:keyable",
      _meta: { "api-key": { apiKey: "good-key" } },
    });
    writeFileSync(join(harness.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "keyable" }));
    const result = await harness.client.logout({});
    expect(result._meta).toMatchObject({ pi: { logout: { cleared: ["keyable"] } } });
  });

  it("treats an unreadable settings.json as no default provider", async () => {
    harness = await Harness.create({
      providers: [keyableProvider()],
      settings: { model: undefined },
    });
    await harness.initialize();
    await harness.client.authenticate({
      methodId: "api-key:keyable",
      _meta: { "api-key": { apiKey: "good-key" } },
    });
    rmSync(join(harness.agentDir, "settings.json"));
    mkdirSync(join(harness.agentDir, "settings.json"));
    const result = await harness.client.logout({});
    expect(result._meta).toMatchObject({ pi: { logout: { cleared: ["keyable"] } } });
  });

  it("treats a settings-manager failure as no default provider", async () => {
    harness = await Harness.create({
      providers: [keyableProvider()],
      settings: { model: undefined },
    });
    await harness.initialize();
    await harness.client.authenticate({
      methodId: "api-key:keyable",
      _meta: { "api-key": { apiKey: "good-key" } },
    });
    const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
    vi.spyOn(SettingsManager, "create").mockImplementation(() => {
      throw new Error("no settings");
    });
    const result = await harness.client.logout({});
    expect(result._meta).toMatchObject({ pi: { logout: { cleared: ["keyable"] } } });
  });

  it("treats a non-object models.json document as nothing to scrub", async () => {
    harness = await Harness.create({ providers: [keyableProvider()] });
    await harness.initialize();
    await harness.client.authenticate({
      methodId: "api-key:keyable",
      _meta: { "api-key": { apiKey: "good-key" } },
    });
    modelsJsonDoc(harness, "[1,2]");
    const result = await harness.client.logout({ _meta: { pi: { logout: { provider: "keyable" } } } });
    expect(result._meta).toMatchObject({ pi: { logout: { cleared: ["keyable"] } } });
  });
});
