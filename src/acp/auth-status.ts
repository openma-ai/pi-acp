/**
 * `_auth/status_update`: pushed whenever pi's credential picture changes.
 *
 * The presence of `agentCapabilities._meta.authStatus` announces the push. The
 * payload lists every provider with a usable credential and the source pi
 * resolved it from, so a client can show "Anthropic · OAuth" without polling.
 */

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { errorMessage, logDebug } from "../log.ts";

export const AUTH_STATUS_UPDATE_METHOD = "_auth/status_update";
export const AUTH_STATUS_META_KEY = "authStatus";

export interface AuthStatusProvider {
  providerId: string;
  name: string;
  /** How the credential is supplied. */
  kind: "api_key" | "oauth" | "environment" | "config" | "other";
  /** pi's human label for the source ("ANTHROPIC_API_KEY", "OAuth", "~/.aws/credentials"). */
  label?: string;
  subscription?: boolean;
}

export interface AuthStatus {
  /** `none` when no provider is usable. */
  kind: "none" | "authenticated";
  label: string;
  providers: AuthStatusProvider[];
}

function kindFromSource(source: string | undefined, oauth: boolean): AuthStatusProvider["kind"] {
  if (oauth) return "oauth";
  switch (source) {
    case "stored":
    case "runtime":
      return "api_key";
    case "environment":
      return "environment";
    case "models_json_key":
    case "models_json_command":
      return "config";
    default:
      return "other";
  }
}

export function computeAuthStatus(modelRuntime: ModelRuntime): AuthStatus {
  const providers: AuthStatusProvider[] = [];
  for (const provider of modelRuntime.getProviders()) {
    if (!modelRuntime.hasConfiguredAuth(provider.id)) continue;
    let status: ReturnType<ModelRuntime["getProviderAuthStatus"]> | undefined;
    try {
      status = modelRuntime.getProviderAuthStatus(provider.id);
    } catch (error: unknown) {
      logDebug(`auth status for ${provider.id} failed: ${errorMessage(error)}`);
    }
    const oauth = modelRuntime.isUsingOAuth(provider.id);
    providers.push({
      providerId: provider.id,
      name: provider.name,
      kind: kindFromSource(status?.source, oauth),
      ...(status?.label !== undefined ? { label: status.label } : oauth ? { label: "OAuth" } : {}),
      ...(modelRuntime.isUsingSubscription(provider.id) ? { subscription: true } : {}),
    });
  }
  providers.sort((a, b) => a.providerId.localeCompare(b.providerId));
  if (providers.length === 0) return { kind: "none", label: "Not logged in", providers };
  const label =
    providers.length === 1
      ? `${providers[0]!.name}${providers[0]!.label !== undefined ? ` · ${providers[0]!.label}` : ""}`
      : `${providers.length} providers`;
  return { kind: "authenticated", label, providers };
}

export function sameAuthStatus(a: AuthStatus | undefined, b: AuthStatus): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}
