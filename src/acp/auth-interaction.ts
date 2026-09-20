/**
 * pi `AuthInteraction` over ACP elicitation.
 *
 * pi provider login flows (OAuth browser/device-code, API-key setup) talk to the
 * user through `AuthInteraction`: `notify` for URLs/codes/progress and `prompt`
 * for text, secrets, selections, and a manual authorization code. This maps them
 * onto ACP:
 *
 * - `auth_url` / `device_code` → `elicitation/create` `mode: "url"` when the
 *   client supports URL elicitation (closed with `elicitation/complete` once the
 *   flow finishes); otherwise a form that shows the URL.
 * - `select` / `text` / `secret` / `manual_code` → form elicitation. Without
 *   form support a `select` takes its first option and a `manual_code` prompt
 *   waits on its signal (the provider's local callback server completes the
 *   flow); other prompts fail.
 *
 * `authenticate` has no session, so every request is request-scoped with the
 * JSON-RPC id of the inbound `authenticate` request.
 */

import type {
  AgentSideConnection,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
} from "@agentclientprotocol/sdk";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { errorMessage, logDebug, logWarn } from "../log.ts";
import { piMeta } from "./meta.ts";
import type { JsonRpcId } from "./request-ids.ts";

export interface AuthInteractionDeps {
  conn: Pick<AgentSideConnection, "createElicitation" | "completeElicitation">;
  requestId: JsonRpcId;
  provider: string;
  urlElicitation: boolean;
  formElicitation: boolean;
  signal: AbortSignal;
}

export class AuthFlowCancelled extends Error {
  constructor(message = "authentication cancelled") {
    super(message);
    this.name = "AuthFlowCancelled";
  }
}

function acceptedContent(response: CreateElicitationResponse): Record<string, unknown> | undefined {
  if (response.action !== "accept") return undefined;
  const content = (response as { content?: unknown }).content;
  return content !== null && typeof content === "object" ? (content as Record<string, unknown>) : {};
}

function deviceCodeMessage(event: Extract<AuthEvent, { type: "device_code" }>): string {
  const expiry =
    event.expiresInSeconds !== undefined
      ? ` (expires in ${Math.round(event.expiresInSeconds / 60)} min)`
      : "";
  return `Open ${event.verificationUri} and enter the code ${event.userCode}${expiry}.`;
}

export interface AcpAuthInteraction extends AuthInteraction {
  /** Close any open URL elicitations; call after the login flow settles. */
  finish(): Promise<void>;
}

export function createAcpAuthInteraction(deps: AuthInteractionDeps): AcpAuthInteraction {
  const { conn, requestId, provider, signal } = deps;
  /** Every URL elicitation opened; all are completed when the flow settles. */
  const openedUrlElicitations: string[] = [];
  let urlSeq = 0;
  /** URL from the latest `auth_url` when the client cannot open URLs itself. */
  let pendingUrl: { url: string; instructions: string | undefined } | undefined;

  const rejectWhenAborted = <T>(promise: Promise<T>, promptSignal?: AbortSignal): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(new AuthFlowCancelled());
      if (signal.aborted || promptSignal?.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      promptSignal?.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
        promptSignal?.removeEventListener("abort", onAbort);
      });
    });

  const form = (
    message: string,
    properties: Record<string, ElicitationPropertySchema>,
    required: string[],
    meta: Record<string, unknown>,
    promptSignal?: AbortSignal,
  ): Promise<CreateElicitationResponse> => {
    const request: CreateElicitationRequest = {
      mode: "form",
      requestId,
      message,
      requestedSchema: { type: "object", properties, required },
      _meta: piMeta({ auth: { provider, ...meta } }),
    };
    return rejectWhenAborted(conn.createElicitation(request), promptSignal);
  };

  const openUrl = (url: string, message: string, meta: Record<string, unknown>): void => {
    urlSeq += 1;
    const elicitationId = `pi-auth-${provider}-${urlSeq}`;
    openedUrlElicitations.push(elicitationId);
    const request: CreateElicitationRequest = {
      mode: "url",
      requestId,
      elicitationId,
      url,
      message,
      _meta: piMeta({ auth: { provider, ...meta } }),
    };
    void conn
      .createElicitation(request)
      .then((response) => {
        if (response.action === "decline" || response.action === "cancel") {
          logDebug(`auth url elicitation ${elicitationId}: ${response.action}`);
        }
      })
      .catch((error: unknown) => {
        logWarn(`auth url elicitation failed: ${errorMessage(error)}`);
      });
  };

  const notify = (event: AuthEvent): void => {
    switch (event.type) {
      case "auth_url": {
        const message = event.instructions ?? "Complete the login in your browser.";
        if (deps.urlElicitation) {
          openUrl(event.url, message, { event: "auth_url" });
        } else {
          pendingUrl = { url: event.url, instructions: event.instructions };
          if (deps.formElicitation) {
            // Shown as a form only when no manual-code prompt follows; see prompt().
            setTimeout(() => {
              if (pendingUrl?.url !== event.url) return;
              pendingUrl = undefined;
              void form(`${message}\n\n${event.url}`, {}, [], { event: "auth_url", url: event.url }).catch(
                () => undefined,
              );
            }, 50);
          } else {
            logWarn(`login[${provider}]: open ${event.url} to continue`);
          }
        }
        return;
      }
      case "device_code": {
        const message = deviceCodeMessage(event);
        if (deps.urlElicitation) {
          openUrl(event.verificationUri, message, {
            event: "device_code",
            userCode: event.userCode,
            ...(event.intervalSeconds !== undefined ? { intervalSeconds: event.intervalSeconds } : {}),
          });
        } else if (deps.formElicitation) {
          void form(message, {}, [], {
            event: "device_code",
            url: event.verificationUri,
            userCode: event.userCode,
          }).catch(() => undefined);
        } else {
          logWarn(`login[${provider}]: ${message}`);
        }
        return;
      }
      case "info":
      case "progress":
        logDebug(`login[${provider}] ${event.type}: ${event.message}`);
        return;
      default:
        return;
    }
  };

  const prompt = async (request: AuthPrompt): Promise<string> => {
    switch (request.type) {
      case "select": {
        if (!deps.formElicitation) {
          const first = request.options[0];
          if (first === undefined) throw new Error("login offered no options");
          logDebug(`login[${provider}]: no form elicitation; choosing "${first.label}"`);
          return first.id;
        }
        const response = await form(
          request.message,
          {
            choice: {
              type: "string",
              title: request.message,
              oneOf: request.options.map((option) => ({
                const: option.id,
                title:
                  option.description !== undefined ? `${option.label} — ${option.description}` : option.label,
              })),
            },
          },
          ["choice"],
          { event: "select", options: request.options.map((option) => option.id) },
          request.signal,
        );
        const value = acceptedContent(response)?.["choice"];
        if (typeof value !== "string") throw new AuthFlowCancelled();
        return value;
      }
      case "manual_code": {
        if (!deps.formElicitation) {
          // The provider's local callback server finishes the flow; the manual
          // prompt only needs to end when the flow (or the request) is aborted.
          return rejectWhenAborted(new Promise<string>(() => {}), request.signal);
        }
        const url = pendingUrl;
        pendingUrl = undefined;
        const message =
          url !== undefined ? `${url.instructions ?? request.message}\n\n${url.url}` : request.message;
        const response = await form(
          message,
          {
            code: {
              type: "string",
              title: request.message,
              ...(request.placeholder !== undefined ? { description: request.placeholder } : {}),
            },
          },
          deps.urlElicitation ? [] : ["code"],
          { event: "manual_code", ...(url !== undefined ? { url: url.url } : {}) },
          request.signal,
        );
        const value = acceptedContent(response)?.["code"];
        if (typeof value !== "string" || value.length === 0) throw new AuthFlowCancelled();
        return value;
      }
      case "text":
      case "secret": {
        if (!deps.formElicitation)
          throw new Error(`login needs user input (${request.message}); the client cannot show forms`);
        const response = await form(
          request.message,
          {
            value: {
              type: "string",
              title: request.message,
              ...(request.placeholder !== undefined ? { description: request.placeholder } : {}),
            },
          },
          ["value"],
          { event: request.type, secret: request.type === "secret" },
          request.signal,
        );
        const value = acceptedContent(response)?.["value"];
        if (typeof value !== "string") throw new AuthFlowCancelled();
        return value;
      }
      default:
        throw new Error("unsupported login prompt");
    }
  };

  return {
    signal,
    notify,
    prompt,
    async finish() {
      const ids = openedUrlElicitations.splice(0);
      for (const elicitationId of ids) {
        try {
          await conn.completeElicitation({ elicitationId });
        } catch (error: unknown) {
          logDebug(`elicitation/complete failed: ${errorMessage(error)}`);
        }
      }
    },
  };
}
