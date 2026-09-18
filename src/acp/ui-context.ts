/**
 * pi `ExtensionUIContext` implemented over ACP.
 *
 * Extensions (and pi core, e.g. project-trust prompts) call `ui.select/confirm/
 * input/editor`. These become standard ACP `elicitation/create` forms when the
 * client advertises form elicitation, and fall back to `session/request_permission`
 * (select/confirm) otherwise. Non-blocking calls (notify, status, widgets, title)
 * become `session_info_update` metadata.
 */

import type {
  AgentSideConnection,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  PermissionOption,
} from "@agentclientprotocol/sdk";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { logDebug, logWarn } from "../log.ts";
import { piMeta } from "./meta.ts";
import type { SessionUpdate } from "./translate.ts";

export interface UiContextDeps {
  conn: AgentSideConnection;
  sessionId: string;
  emit: (update: SessionUpdate) => void;
  formElicitation: () => boolean;
  /** Theme object required by the interface; pi's default theme singleton works. */
  theme: ExtensionUIContext["theme"];
}

const CHOICE_PREFIX = "choice-";

function withDialogOptions<T>(
  opts: ExtensionUIDialogOptions | undefined,
  fallback: T,
  run: () => Promise<T>,
): Promise<T> {
  if (opts?.signal?.aborted) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish(fallback);
    const timer = opts?.timeout !== undefined ? setTimeout(() => finish(fallback), opts.timeout) : undefined;
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    run().then(finish, (error: unknown) => {
      logDebug(`extension UI request failed: ${String(error)}`);
      finish(fallback);
    });
  });
}

function acceptedContent(response: CreateElicitationResponse): Record<string, unknown> | undefined {
  if (response.action !== "accept") return undefined;
  const content = (response as { content?: unknown }).content;
  return content !== null && typeof content === "object" ? (content as Record<string, unknown>) : {};
}

export function createAcpUiContext(deps: UiContextDeps): ExtensionUIContext {
  const { conn, sessionId, emit } = deps;

  const elicit = (
    message: string,
    properties: Record<string, ElicitationPropertySchema>,
    required: string[],
    meta: Record<string, unknown>,
  ): Promise<CreateElicitationResponse> => {
    const request: CreateElicitationRequest = {
      mode: "form",
      sessionId,
      message,
      requestedSchema: { type: "object", properties, required },
      _meta: piMeta(meta),
    };
    return conn.createElicitation(request);
  };

  const requestChoice = async (
    title: string,
    method: string,
    options: PermissionOption[],
    rawInput: Record<string, unknown>,
  ): Promise<string | undefined> => {
    const response = await conn.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: `pi-ui-${method}-${Date.now().toString(36)}`,
        title,
        kind: "other",
        status: "pending",
        rawInput: { method, ...rawInput },
      },
      options,
    });
    return response.outcome.outcome === "selected" ? response.outcome.optionId : undefined;
  };

  const infoMeta = (value: Record<string, unknown>): void => {
    emit({ sessionUpdate: "session_info_update", _meta: piMeta(value) });
  };

  return {
    select: (title, options, opts) =>
      withDialogOptions(opts, undefined, async () => {
        if (options.length === 0) return undefined;
        if (deps.formElicitation()) {
          const response = await elicit(
            title,
            {
              choice: {
                type: "string",
                title,
                oneOf: options.map((option, index) => ({ const: `${CHOICE_PREFIX}${index}`, title: option })),
              },
            },
            ["choice"],
            { ui: "select", title, options },
          );
          const content = acceptedContent(response);
          const value = content?.["choice"];
          if (typeof value !== "string" || !value.startsWith(CHOICE_PREFIX)) return undefined;
          return options[Number(value.slice(CHOICE_PREFIX.length))];
        }
        const optionId = await requestChoice(
          title,
          "select",
          options.map((name, index) => ({ optionId: `${CHOICE_PREFIX}${index}`, name, kind: "allow_once" })),
          { options },
        );
        if (optionId === undefined || !optionId.startsWith(CHOICE_PREFIX)) return undefined;
        return options[Number(optionId.slice(CHOICE_PREFIX.length))];
      }),

    confirm: (title, message, opts) =>
      withDialogOptions(opts, false, async () => {
        if (deps.formElicitation()) {
          const response = await elicit(
            `${title}\n\n${message}`,
            { confirmed: { type: "boolean", title, description: message } },
            ["confirmed"],
            { ui: "confirm", title, message },
          );
          const content = acceptedContent(response);
          return content?.["confirmed"] === true;
        }
        const optionId = await requestChoice(
          title,
          "confirm",
          [
            { optionId: "yes", name: "Yes", kind: "allow_once" },
            { optionId: "no", name: "No", kind: "reject_once" },
          ],
          { message },
        );
        return optionId === "yes";
      }),

    input: (title, placeholder, opts) =>
      withDialogOptions(opts, undefined, async () => {
        if (!deps.formElicitation()) {
          logWarn(`extension input "${title}" cancelled: client does not support form elicitation`);
          return undefined;
        }
        const response = await elicit(
          title,
          {
            value: {
              type: "string",
              title,
              ...(placeholder !== undefined ? { description: placeholder } : {}),
            },
          },
          ["value"],
          { ui: "input", title, ...(placeholder !== undefined ? { placeholder } : {}) },
        );
        const content = acceptedContent(response);
        const value = content?.["value"];
        return typeof value === "string" ? value : undefined;
      }),

    editor: async (title, prefill) => {
      if (!deps.formElicitation()) {
        logWarn(`extension editor "${title}" cancelled: client does not support form elicitation`);
        return undefined;
      }
      try {
        const response = await elicit(
          title,
          { value: { type: "string", title, ...(prefill !== undefined ? { default: prefill } : {}) } },
          ["value"],
          { ui: "editor", title, ...(prefill !== undefined ? { prefill } : {}) },
        );
        const content = acceptedContent(response);
        const value = content?.["value"];
        return typeof value === "string" ? value : undefined;
      } catch (error: unknown) {
        logDebug(`extension editor failed: ${String(error)}`);
        return undefined;
      }
    },

    notify(message, type) {
      emit({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `\n> ${type === "error" ? "⚠ " : type === "warning" ? "! " : ""}${message}\n`,
        },
        _meta: piMeta({ notify: { level: type ?? "info", message } }),
      });
    },
    onTerminalInput: () => () => {},
    setStatus: (key, text) => infoMeta({ event: "status", key, text: text ?? null }),
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
      if (content === undefined || Array.isArray(content)) {
        infoMeta({
          event: "widget",
          key,
          lines: content ?? null,
          placement: options?.placement ?? "aboveEditor",
        });
      }
    },
    setFooter: () => {},
    setHeader: () => {},
    setTitle: (title) =>
      emit({ sessionUpdate: "session_info_update", title, updatedAt: new Date().toISOString() }),
    custom: async () => undefined as never,
    pasteToEditor: (text) => infoMeta({ event: "editor_text", text }),
    setEditorText: (text) => infoMeta({ event: "editor_text", text }),
    getEditorText: () => "",
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme() {
      return deps.theme;
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching is not available over ACP" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}
