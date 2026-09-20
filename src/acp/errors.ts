import { RequestError } from "@agentclientprotocol/sdk";

export function invalidParams(detail: string, data?: Record<string, unknown>): RequestError {
  return RequestError.invalidParams(data, detail);
}

export function internalError(detail: string, data?: Record<string, unknown>): RequestError {
  return RequestError.internalError(data, detail);
}

export function authRequired(detail: string, data?: Record<string, unknown>): RequestError {
  return RequestError.authRequired(data, detail);
}

const AUTH_PATTERNS = [
  "no api key",
  "api key",
  "apikey",
  "not configured",
  "no model selected",
  "no models available",
  "authentication failed",
  "unauthorized",
  "invalid x-api-key",
  "401",
  "403",
];

/** Heuristic: does a pi/provider error mean the user must (re)authenticate? */
export function looksLikeAuthError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return AUTH_PATTERNS.some((pattern) => message.includes(pattern));
}

/** Typed failure classes surfaced as `_meta.piAcp.event: "failure"` and on prompt errors. */
export type FailureKind =
  | "auth_required"
  | "rate_limited"
  | "context_overflow"
  | "network"
  | "provider_error"
  | "cancelled"
  | "unknown";

export function classifyFailure(message: string): FailureKind {
  const lowered = message.toLowerCase();
  if (lowered.includes("abort") || lowered.includes("cancel")) return "cancelled";
  if (looksLikeAuthError(message)) return "auth_required";
  if (/(429|rate limit|rate_limit|too many requests|quota|overloaded|529)/.test(lowered))
    return "rate_limited";
  if (
    /(context (window|length)|too long|maximum context|prompt is too large|exceeds the (context|token))/.test(
      lowered,
    )
  )
    return "context_overflow";
  if (/(econnreset|econnrefused|enotfound|etimedout|fetch failed|network|socket|dns|timeout)/.test(lowered))
    return "network";
  if (/(500|502|503|504|internal server error|bad gateway|service unavailable|upstream)/.test(lowered))
    return "provider_error";
  return "unknown";
}
