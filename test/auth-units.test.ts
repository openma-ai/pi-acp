/**
 * Unit coverage for the auth helpers in src/acp/auth.ts (launch spec, gateway
 * and logout-scope parsing, method advertisement) that the e2e tests cannot
 * reach through the harness.
 */

import { describe, expect, it } from "vitest";
import {
  apiKeyFromAuthenticate,
  buildAuthMethods,
  gatewayFromAuthenticate,
  logoutScopeFromMeta,
  parseAuthMethodId,
  terminalLaunchSpec,
} from "../src/acp/auth.ts";
import { isNativeAuthCommand } from "../src/acp/commands.ts";

describe("terminalLaunchSpec", () => {
  it("advertises the package bin name with only the login flag", () => {
    // The `_meta["terminal-auth"]` convention (claude-agent-acp, dsh-acp):
    // `command` is the bin name and `args` carry only flags — spec clients
    // append `args` to the argv they spawned the agent with, so a script
    // path here would arrive as a stray positional arg and exit the login
    // process on resolveSettings's unknown-option error.
    expect(terminalLaunchSpec()).toEqual({
      command: "openma-pi-acp",
      args: ["--terminal-login"],
    });
  });

  it("matches the spec-level args/env of the advertised terminal method", () => {
    const spec = terminalLaunchSpec();
    const [method] = buildAuthMethods(undefined, {
      terminal: false,
      gateway: false,
      terminalAuthMeta: true,
      urlElicitation: false,
      formElicitation: false,
    });
    expect(method).toMatchObject({ type: "terminal", args: spec.args, env: {} });
    expect(method?._meta?.["terminal-auth"]).toMatchObject({
      command: spec.command,
      args: spec.args,
      label: "Log in with pi",
    });
  });
});

describe("gatewayFromAuthenticate", () => {
  const baseUrl = "https://gw.example.com/v1";

  it("returns undefined without a gateway block", () => {
    expect(gatewayFromAuthenticate(undefined)).toBeUndefined();
    expect(gatewayFromAuthenticate(null)).toBeUndefined();
    expect(gatewayFromAuthenticate({})).toBeUndefined();
    expect(gatewayFromAuthenticate({ gateway: null })).toBeUndefined();
  });

  it("parses the Backchat shape: baseUrl + Authorization Bearer + providerName", () => {
    const parsed = gatewayFromAuthenticate({
      gateway: {
        baseUrl,
        headers: { Authorization: "Bearer sk-gw", "X-Team": "eng" },
        providerName: "My Gateway",
      },
    });
    expect(parsed).toEqual({
      submission: {
        provider: "my-gateway",
        name: "My Gateway",
        baseUrl,
        apiKey: "sk-gw",
        headers: { "X-Team": "eng" },
        api: undefined,
        models: undefined,
      },
    });
  });

  it("defaults the provider id to 'gateway' without providerName; accepts x-api-key, bare auth header, api, models", () => {
    const parsed = gatewayFromAuthenticate({
      gateway: {
        baseUrl,
        api: "anthropic-messages",
        headers: { "x-api-key": "k2", Authorization: "raw-token" },
        models: [{ id: "m1", api: "openai-completions" }, "m2"],
      },
    });
    expect(parsed).toMatchObject({
      submission: {
        provider: "gateway",
        name: undefined,
        apiKey: "raw-token",
        headers: {},
        api: "anthropic-messages",
        models: [{ id: "m1", api: "openai-completions" }, { id: "m2" }],
      },
    });
  });

  it("yields no key for a blank Authorization header", () => {
    const parsed = gatewayFromAuthenticate({
      gateway: { baseUrl, headers: { Authorization: "   " } },
    });
    expect(parsed).toMatchObject({ submission: { apiKey: undefined } });
  });

  it("rejects malformed input with a usable message", () => {
    const errors = [
      { gateway: "x" },
      { gateway: { baseUrl: "ftp://x" } },
      { gateway: { baseUrl: 1 } },
      { gateway: { baseUrl, headers: 5 } },
      { gateway: { baseUrl, headers: { A: 5 } } },
      { gateway: { baseUrl, providerName: "!!!" } },
      { gateway: { baseUrl, api: 5 } },
      { gateway: { baseUrl, models: "x" } },
      { gateway: { baseUrl, models: [{}] } },
      { gateway: { baseUrl, models: [null] } },
    ];
    for (const meta of errors) {
      const parsed = gatewayFromAuthenticate(meta);
      expect(parsed, JSON.stringify(meta)).toHaveProperty("error");
    }
  });
});

describe("logoutScopeFromMeta", () => {
  it("reads _meta.pi.logout", () => {
    expect(logoutScopeFromMeta(undefined)).toEqual({});
    expect(logoutScopeFromMeta(null)).toEqual({});
    expect(logoutScopeFromMeta({})).toEqual({});
    expect(logoutScopeFromMeta({ pi: 5 })).toEqual({});
    expect(logoutScopeFromMeta({ pi: {} })).toEqual({});
    expect(logoutScopeFromMeta({ pi: { logout: "x" } })).toEqual({});
    expect(logoutScopeFromMeta({ pi: { logout: { provider: "openai" } } })).toEqual({
      provider: "openai",
    });
    expect(logoutScopeFromMeta({ pi: { logout: { all: true } } })).toEqual({ all: true });
    expect(logoutScopeFromMeta({ pi: { logout: { all: false, provider: "" } } })).toEqual({});
  });
});

describe("auth method ids", () => {
  it("parses api-key:/oauth: prefixes", () => {
    expect(parseAuthMethodId("api-key:anthropic")).toEqual({ type: "api_key", provider: "anthropic" });
    expect(parseAuthMethodId("oauth:x")).toEqual({ type: "oauth", provider: "x" });
    expect(parseAuthMethodId("other")).toBeUndefined();
    expect(isNativeAuthCommand("login")).toBe(true);
    expect(isNativeAuthCommand("logout")).toBe(true);
    expect(isNativeAuthCommand("model")).toBe(false);
  });

  it('reads _meta["api-key"]', () => {
    expect(apiKeyFromAuthenticate(undefined)).toEqual({});
    expect(apiKeyFromAuthenticate({ "api-key": "x" })).toEqual({});
    expect(apiKeyFromAuthenticate({ "api-key": { apiKey: "", provider: 5 } })).toEqual({});
    expect(apiKeyFromAuthenticate({ "api-key": { apiKey: "k", provider: "p" } })).toEqual({
      apiKey: "k",
      provider: "p",
    });
  });
});

describe("buildAuthMethods gating", () => {
  const options = {
    terminal: false,
    gateway: false,
    terminalAuthMeta: false,
    urlElicitation: false,
    formElicitation: false,
  };

  it("advertises nothing without a runtime and no client features", () => {
    expect(buildAuthMethods(undefined, options)).toEqual([]);
  });

  it("advertises the terminal method for auth.terminal or the terminal-auth convention", () => {
    const viaCap = buildAuthMethods(undefined, { ...options, terminal: true });
    expect(viaCap.map((m) => m.id)).toEqual(["pi-terminal-login"]);
    expect(viaCap[0]).toMatchObject({ type: "terminal", args: ["--terminal-login"], env: {} });
    expect(viaCap[0]?._meta).toBeUndefined();

    const viaMeta = buildAuthMethods(undefined, { ...options, terminalAuthMeta: true });
    expect(viaMeta[0]?._meta).toMatchObject({
      "terminal-auth": { args: expect.arrayContaining(["--terminal-login"]), label: "Log in with pi" },
    });
  });

  it("advertises the gateway method only for auth._meta.gateway", () => {
    const methods = buildAuthMethods(undefined, { ...options, gateway: true });
    expect(methods.map((m) => m.id)).toEqual(["gateway"]);
    expect(methods[0]?._meta).toMatchObject({ gateway: { protocol: "openai-completions" } });
  });
});
