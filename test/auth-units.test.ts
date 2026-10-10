/**
 * Unit coverage for the auth helpers in src/acp/auth.ts (launch spec, gateway
 * and logout-scope parsing, method advertisement) that the e2e tests cannot
 * reach through the harness.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  apiKeyFromAuthenticate,
  buildAuthMethods,
  gatewayFromAuthenticate,
  logoutScopeFromMeta,
  parseAuthMethodId,
  terminalLaunchSpec,
} from "../src/acp/auth.ts";
import { isNativeAuthCommand } from "../src/acp/commands.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Create a fake package tree; returns the package root. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pi-acp-auth-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

describe("terminalLaunchSpec", () => {
  it("reruns the entry script under node (node + dist/bin.js)", () => {
    expect(terminalLaunchSpec(["/usr/bin/node", "/app/dist/bin.js"], "file:///nope", "/x/node")).toEqual({
      command: "/x/node",
      args: ["/app/dist/bin.js", "--terminal-login"],
    });
  });

  it("accepts .mjs/.cjs/.ts entry scripts", () => {
    for (const name of ["x.mjs", "x.cjs", "x.ts"]) {
      expect(terminalLaunchSpec(["node", `/a/${name}`], "file:///nope", "/x/node").args).toEqual([
        `/a/${name}`,
        "--terminal-login",
      ]);
    }
  });

  it("resolves the packaged bin when argv[1] has no script extension", () => {
    const root = fixture({
      "package.json": JSON.stringify({
        name: "@openma/pi-acp",
        bin: { "openma-pi-acp": "dist/bin.js" },
      }),
      "dist/bin.js": "// bin",
      "dist/chunk.js": "// mod",
    });
    const spec = terminalLaunchSpec(
      ["weird-launcher", "/opt/bin/openma-pi-acp"],
      pathToFileURL(join(root, "dist/chunk.js")).href,
      "/x/node",
    );
    expect(spec).toEqual({ command: "/x/node", args: [join(root, "dist/bin.js"), "--terminal-login"] });
  });

  it("falls back to the bin name when the package cannot be resolved", () => {
    const spec = terminalLaunchSpec(["weird", "/opt/bin/tool"], "file:///nothing/here.js", "/x/node");
    expect(spec).toEqual({ command: "openma-pi-acp", args: ["--terminal-login"] });
  });

  it("stops at the nearest package.json even when it is another package", () => {
    const root = fixture({ "package.json": JSON.stringify({ name: "other", bin: {} }) });
    const spec = terminalLaunchSpec(
      ["weird", "/opt/bin/tool"],
      pathToFileURL(join(root, "x.js")).href,
      "/x/node",
    );
    expect(spec.command).toBe("openma-pi-acp");
  });

  it("falls back on malformed package.json, missing bin entry, missing bin file, bad module url", () => {
    const malformed = fixture({ "package.json": "{oops" });
    for (const url of [
      pathToFileURL(join(malformed, "x.js")).href,
      (() => {
        const noBin = fixture({ "package.json": JSON.stringify({ name: "@openma/pi-acp", bin: {} }) });
        return pathToFileURL(join(noBin, "x.js")).href;
      })(),
      (() => {
        const missing = fixture({
          "package.json": JSON.stringify({
            name: "@openma/pi-acp",
            bin: { "openma-pi-acp": "dist/bin.js" },
          }),
        });
        return pathToFileURL(join(missing, "x.js")).href;
      })(),
      "not-a-file-url",
    ]) {
      expect(terminalLaunchSpec(["weird", "/opt/bin/tool"], url, "/x/node").command).toBe("openma-pi-acp");
    }
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

  it("falls back when bin is a string, and yields no key for a blank Authorization header", () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "@openma/pi-acp", bin: "cli.js" }),
    });
    expect(terminalLaunchSpec([], `file://${root}/dist/bin.js`)).toEqual({
      command: "openma-pi-acp",
      args: ["--terminal-login"],
    });
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
