/**
 * Terminal-auth method advertisement (ACP registry + Zed banner) and helpers.
 *
 * pi owns credentials (`~/.pi/agent/auth.json`, provider OAuth flows). Two ways in:
 *
 * 1. `terminal` auth: the client launches `openma-pi-acp --terminal-login`,
 *    which runs pi interactively so the user can `/login`.
 * 2. Agent auth with `_meta["api-key"]`: `api-key:<provider>` stores an API key
 *    through pi's ModelRuntime (same store pi reads).
 */

import type { AuthMethod } from "@agentclientprotocol/sdk";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const TERMINAL_AUTH_METHOD_ID = "pi-terminal-login";
export const API_KEY_METHOD_PREFIX = "api-key:";

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

export function buildAuthMethods(
  modelRuntime: ModelRuntime | undefined,
  terminalAuthMeta: boolean,
): AuthMethod[] {
  const launch = terminalLaunchSpec();
  const terminal: AuthMethod = {
    type: "terminal",
    id: TERMINAL_AUTH_METHOD_ID,
    name: "Log in with pi",
    description: "Open pi in a terminal to configure API keys or sign in with a provider",
    args: ["--terminal-login"],
    env: {},
    ...(terminalAuthMeta ? { _meta: { "terminal-auth": { ...launch, label: "Log in with pi" } } } : {}),
  };
  const methods: AuthMethod[] = [terminal];
  if (modelRuntime !== undefined) {
    const providers = [...modelRuntime.getProviders()].sort((a, b) => {
      const ia = FEATURED_PROVIDERS.indexOf(a.id);
      const ib = FEATURED_PROVIDERS.indexOf(b.id);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.id.localeCompare(b.id);
    });
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
  }
  return methods;
}

export function providerFromAuthMethodId(methodId: string): string | undefined {
  return methodId.startsWith(API_KEY_METHOD_PREFIX)
    ? methodId.slice(API_KEY_METHOD_PREFIX.length)
    : undefined;
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
