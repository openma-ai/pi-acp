/**
 * Auth method advertisement and helpers.
 *
 * pi owns credentials (`~/.pi/agent/auth.json`, provider OAuth flows). Ways in,
 * each gated on what the client declared in `initialize`:
 *
 * 1. `terminal` auth (`auth.terminal` or `_meta["terminal-auth"]`): the client
 *    launches `openma-pi-acp --terminal-login`, a focused pi login flow.
 * 2. `api-key:<provider>`: stores an API key through pi's ModelRuntime (same
 *    store pi reads). The openma `_meta["api-key"]` extension carries the key;
 *    clients that only support `elicitation/create` mode "url" get a loopback
 *    key-entry page instead (see auth-loopback.ts).
 * 3. `oauth:<provider>`: runs pi's provider OAuth flow, with the browser URL /
 *    device code / manual code delivered through ACP elicitation (see
 *    auth-interaction.ts). Advertised only when the client can show a URL or a
 *    form.
 * 4. `gateway` (`auth._meta.gateway`): `_meta.gateway` carries
 *    `{baseUrl, headers?, providerName?}`; the provider is written into
 *    models.json so pi serves it like any configured provider.
 */

import type { AuthMethod } from "@agentclientprotocol/sdk";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_NAME, PACKAGE_NAME } from "../version.ts";
import { piMeta } from "./meta.ts";

export const TERMINAL_AUTH_METHOD_ID = "pi-terminal-login";
export const API_KEY_METHOD_PREFIX = "api-key:";
export const OAUTH_METHOD_PREFIX = "oauth:";
export const GATEWAY_METHOD_ID = "gateway";

/**
 * How the client should spawn the adapter for the terminal auth method. Under
 * `node dist/bin.js` (npx, global bin shim, plain node) argv[1] is the entry
 * script; for anything else (renamed shims, bundlers) resolve this package's
 * own bin file so the spec never depends on a global `openma-pi-acp` on PATH.
 */
export function terminalLaunchSpec(
  argv: readonly string[] = process.argv,
  moduleUrl: string = import.meta.url,
  execPath: string = process.execPath,
): { command: string; args: string[] } {
  const argv1 = argv[1];
  if (argv1 !== undefined && /\.(m?js|cjs|ts)$/.test(argv1)) {
    return { command: execPath, args: [argv1, "--terminal-login"] };
  }
  const packaged = packagedBin(moduleUrl);
  if (packaged !== undefined) return { command: execPath, args: [packaged, "--terminal-login"] };
  return { command: AGENT_NAME, args: ["--terminal-login"] };
}

/** This package's bin file, found by walking up from the module to its package.json. */
function packagedBin(moduleUrl: string): string | undefined {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(moduleUrl));
  } catch {
    return undefined;
  }
  for (let i = 0; i < 6; i += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
          name?: unknown;
          bin?: unknown;
        };
        if (pkg.name !== PACKAGE_NAME) return undefined;
        const entry =
          typeof pkg.bin === "object" && pkg.bin !== null
            ? (pkg.bin as Record<string, unknown>)[AGENT_NAME]
            : undefined;
        if (typeof entry !== "string") return undefined;
        const bin = join(dir, entry);
        return existsSync(bin) ? bin : undefined;
      } catch {
        return undefined;
      }
    }
    dir = dirname(dir);
  }
  return undefined;
}

/** Providers whose API-key method is advertised even before any credential exists. */
const FEATURED_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "xai",
  "groq",
  "mistral",
  "deepseek",
  "moonshot",
  "zai",
  "minimax",
];

export interface AuthMethodOptions {
  /** Client declared `capabilities.auth.terminal`. */
  terminal: boolean;
  /** Client declared `capabilities.auth._meta.gateway`. */
  gateway: boolean;
  /** Client advertised the `_meta["terminal-auth"]` convention. */
  terminalAuthMeta: boolean;
  /** Client supports `elicitation/create` `mode: "url"`. */
  urlElicitation: boolean;
  /** Client supports `elicitation/create` `mode: "form"`. */
  formElicitation: boolean;
}

function rank(providerId: string): number {
  const index = FEATURED_PROVIDERS.indexOf(providerId);
  return index === -1 ? 99 : index;
}

export function buildAuthMethods(
  modelRuntime: ModelRuntime | undefined,
  options: AuthMethodOptions,
): AuthMethod[] {
  const methods: AuthMethod[] = [];
  if (options.terminal || options.terminalAuthMeta) {
    const launch = terminalLaunchSpec();
    methods.push({
      type: "terminal",
      id: TERMINAL_AUTH_METHOD_ID,
      name: "Log in with pi",
      description: "Open pi's terminal login to configure API keys or sign in with a provider",
      args: ["--terminal-login"],
      env: {},
      ...(options.terminalAuthMeta
        ? { _meta: { "terminal-auth": { ...launch, label: "Log in with pi" } } }
        : {}),
    });
  }
  if (options.gateway) {
    methods.push({
      id: GATEWAY_METHOD_ID,
      name: "Custom model gateway",
      description:
        "Route models through a custom OpenAI-compatible gateway (baseUrl + headers via _meta.gateway)",
      _meta: { gateway: { protocol: "openai-completions" } },
    });
  }
  if (modelRuntime === undefined) return methods;

  const providers = [...modelRuntime.getProviders()].sort(
    (a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id),
  );
  if (options.urlElicitation || options.formElicitation) {
    for (const provider of providers) {
      const oauth = provider.auth.oauth;
      if (oauth === undefined) continue;
      methods.push({
        id: `${OAUTH_METHOD_PREFIX}${provider.id}`,
        name: oauth.loginLabel ?? `Sign in to ${oauth.name}`,
        description:
          oauth.isSubscription === true
            ? `Use your ${oauth.name} subscription; the login happens in your browser`
            : `Sign in to ${oauth.name} in your browser`,
        _meta: piMeta({ oauth: { provider: provider.id, subscription: oauth.isSubscription === true } }),
      });
    }
  }
  for (const provider of providers) {
    if (provider.auth.apiKey === undefined) continue;
    if (!FEATURED_PROVIDERS.includes(provider.id) && !modelRuntime.hasConfiguredAuth(provider.id)) continue;
    methods.push({
      id: `${API_KEY_METHOD_PREFIX}${provider.id}`,
      name: `${provider.name} API key`,
      description: `Provide a ${provider.name} API key; stored in pi's credential store`,
      _meta: { "api-key": { provider: provider.id } },
    });
  }
  return methods;
}

export interface ParsedAuthMethod {
  type: "api_key" | "oauth";
  provider: string;
}

export function parseAuthMethodId(methodId: string): ParsedAuthMethod | undefined {
  if (methodId.startsWith(API_KEY_METHOD_PREFIX)) {
    return { type: "api_key", provider: methodId.slice(API_KEY_METHOD_PREFIX.length) };
  }
  if (methodId.startsWith(OAUTH_METHOD_PREFIX)) {
    return { type: "oauth", provider: methodId.slice(OAUTH_METHOD_PREFIX.length) };
  }
  return undefined;
}

export function apiKeyFromAuthenticate(meta: unknown): { apiKey?: string; provider?: string } {
  if (meta === null || typeof meta !== "object") return {};
  const block = (meta as Record<string, unknown>)["api-key"];
  if (block === null || typeof block !== "object") return {};
  const record = block as Record<string, unknown>;
  return {
    ...(typeof record["apiKey"] === "string" && record["apiKey"].length > 0
      ? { apiKey: record["apiKey"] }
      : {}),
    ...(typeof record["provider"] === "string" && record["provider"].length > 0
      ? { provider: record["provider"] }
      : {}),
  };
}

/** A models.json model entry: at minimum an `id`; the rest passes through. */
export type GatewayModel = { id: string } & Record<string, unknown>;

export interface GatewaySubmission {
  /** Provider id the gateway config is stored under. */
  provider: string;
  /** Display name (providerName verbatim) for the models.json `name` field. */
  name: string | undefined;
  baseUrl: string;
  /** Bearer/x-api-key value lifted out of `headers`, stored as the provider `apiKey`. */
  apiKey: string | undefined;
  /** Non-auth headers passed through to the provider config. */
  headers: Record<string, string>;
  /** Provider-level wire API (`api` field in models.json); undefined = openai-completions. */
  api: string | undefined;
  models: GatewayModel[] | undefined;
}

const GATEWAY_META_HINT =
  '_meta.gateway = {"baseUrl": "https://…", "headers"?: {"Authorization": "Bearer <key>"}, "providerName"?: "…", "models"?: [{"id": "…"}]}';

function slugifyProviderId(name: string): string | undefined {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : undefined;
}

function gatewayModels(raw: unknown): { models: GatewayModel[] } | { models: undefined } | { error: string } {
  if (raw === undefined || raw === null) return { models: undefined };
  if (!Array.isArray(raw)) return { error: `${GATEWAY_META_HINT} — "models" must be an array` };
  const models: GatewayModel[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) {
      models.push({ id: entry });
      continue;
    }
    if (entry === null || typeof entry !== "object" || typeof (entry as { id?: unknown }).id !== "string") {
      return { error: `${GATEWAY_META_HINT} — each model needs at least an "id"` };
    }
    models.push(entry as GatewayModel);
  }
  return { models };
}

/**
 * Parse the openma `_meta.gateway` authenticate payload
 * (`{baseUrl, headers?, providerName?, models?}`) into a provider config write.
 * `undefined` = no gateway block; `{error}` = malformed.
 */
export function gatewayFromAuthenticate(
  meta: unknown,
): { submission: GatewaySubmission } | { error: string } | undefined {
  if (meta === null || typeof meta !== "object") return undefined;
  const block = (meta as Record<string, unknown>)["gateway"];
  if (block === undefined || block === null) return undefined;
  if (typeof block !== "object") return { error: `${GATEWAY_META_HINT} — the value must be an object` };
  const record = block as Record<string, unknown>;
  const baseUrl = typeof record["baseUrl"] === "string" ? record["baseUrl"].trim() : "";
  if (!/^https?:\/\/.+/.test(baseUrl)) {
    return { error: `${GATEWAY_META_HINT} — "baseUrl" must be an http(s) URL` };
  }
  const headers: Record<string, string> = {};
  let apiKey: string | undefined;
  const rawHeaders = record["headers"];
  if (rawHeaders !== undefined && rawHeaders !== null) {
    if (typeof rawHeaders !== "object") {
      return { error: `${GATEWAY_META_HINT} — "headers" must be an object` };
    }
    for (const [name, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value !== "string") {
        return { error: `${GATEWAY_META_HINT} — header "${name}" must be a string` };
      }
      const lower = name.toLowerCase();
      if (lower === "authorization") {
        const match = /^bearer\s+(.+)$/i.exec(value.trim());
        apiKey = (match?.[1] ?? value.trim()) || undefined;
      } else if (lower === "x-api-key") {
        apiKey = value;
      } else {
        headers[name] = value;
      }
    }
  }
  const providerName =
    typeof record["providerName"] === "string" && record["providerName"].length > 0
      ? record["providerName"]
      : undefined;
  const provider = providerName === undefined ? "gateway" : slugifyProviderId(providerName);
  if (provider === undefined) {
    return { error: `${GATEWAY_META_HINT} — "providerName" "${providerName}" does not contain a usable id` };
  }
  const api = record["api"];
  if (api !== undefined && (typeof api !== "string" || api.length === 0)) {
    return { error: `${GATEWAY_META_HINT} — "api" must be a string like "openai-completions"` };
  }
  const parsed = gatewayModels(record["models"]);
  if ("error" in parsed) return { error: parsed.error };
  return {
    submission: {
      provider,
      name: providerName,
      baseUrl,
      apiKey,
      headers,
      api: api as string | undefined,
      models: parsed.models,
    },
  };
}

/**
 * Read the optional `_meta.pi.logout` scope: `{provider: "<id>"}` clears one
 * provider's credential, `{all: true}` clears every removable credential.
 * Missing/empty = the caller resolves the active provider.
 */
export function logoutScopeFromMeta(meta: unknown): { provider?: string; all?: boolean } {
  if (meta === null || typeof meta !== "object") return {};
  const pi = (meta as Record<string, unknown>)["pi"];
  if (pi === null || typeof pi !== "object") return {};
  const scope = (pi as Record<string, unknown>)["logout"];
  if (scope === null || typeof scope !== "object") return {};
  const record = scope as Record<string, unknown>;
  return {
    ...(typeof record["provider"] === "string" && record["provider"].length > 0
      ? { provider: record["provider"] }
      : {}),
    ...(record["all"] === true ? { all: true } : {}),
  };
}
