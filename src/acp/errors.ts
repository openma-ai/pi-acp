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
