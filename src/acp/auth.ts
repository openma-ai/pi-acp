/**
 * Auth method advertisement and helpers.
 *
 * pi owns credentials (`~/.pi/agent/auth.json`, provider OAuth flows). Three ways in:
 *
 * 1. `terminal` auth: the client launches `openma-pi-acp --terminal-login`,
 *    which runs pi interactively so the user can `/login`.
 * 2. `api-key:<provider>` with `_meta["api-key"].apiKey`: stores an API key
 *    through pi's ModelRuntime (same store pi reads).
 * 3. `oauth:<provider>`: runs pi's provider OAuth flow, with the browser URL /
 *    device code / manual code delivered through ACP elicitation
 *    (see auth-interaction.ts). Advertised only when the client can show a URL
 *    or a form.
 */

import type { AuthMethod } from "@agentclientprotocol/sdk";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { piMeta } from "./meta.ts";

export const TERMINAL_AUTH_METHOD_ID = "pi-terminal-login";
export const API_KEY_METHOD_PREFIX = "api-key:";
export const OAUTH_METHOD_PREFIX = "oauth:";

export function terminalLaunchSpec(): { command: string; args: string[] } {
  const argv0 = process.argv[0] ?? "node";
  const argv1 = process.argv[1];
  if (argv1 !== undefined && /node/.test(argv0) && /\.(m?js|ts)$/.test(argv1)) {
    return { command: argv0, args: [argv1, "--terminal-login"] };
  }
  return { command: "openma-pi-acp", args: ["--terminal-login"] };
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
  /** Client advertised Zed's `_meta["terminal-auth"]`. */
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
  const launch = terminalLaunchSpec();
  const terminal: AuthMethod = {
    type: "terminal",
    id: TERMINAL_AUTH_METHOD_ID,
    name: "Log in with pi",
    description: "Open pi in a terminal to configure API keys or sign in with a provider",
    args: ["--terminal-login"],
    env: {},
    ...(options.terminalAuthMeta
      ? { _meta: { "terminal-auth": { ...launch, label: "Log in with pi" } } }
      : {}),
  };
  const methods: AuthMethod[] = [terminal];
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
