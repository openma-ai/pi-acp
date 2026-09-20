/**
 * One ACP session ↔ one pi `AgentSessionRuntime`, in-process.
 *
 * Owns runtime creation (services, tools, permission gate extension), event
 * projection to `session/update`, prompt lifecycle (inflight turn, steering,
 * cancellation), permission requests, MCP mounts, and teardown.
 */

import type {
  AgentSideConnection,
  AvailableCommand,
  McpServer,
  SessionConfigOption,
  StopReason,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import {
  AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI,
  type InlineExtension,
  type ModelRuntime,
  type ToolDefinition,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { readFileSync } from "node:fs";
import { errorMessage, logDebug, logWarn } from "../log.ts";
import type { Settings } from "../settings.ts";
import { availableCommandsFor } from "./commands.ts";
import { buildConfigOptions, findModel, modelValue } from "./config-options.ts";
import { createDelegatedTools, type DelegationCapabilities } from "./delegation.ts";
import { authRequired, classifyFailure, internalError, invalidParams, looksLikeAuthError } from "./errors.ts";
import { createTappedEventBus, describeExtensionEvent, type TappedEventBus } from "./extension-events.ts";
import { buildReplay } from "./history.ts";
import { mountMcpServers, type McpMount } from "./mcp.ts";
import { piMeta } from "./meta.ts";
import {
  decisionFromOptionId,
  PERMISSION_OPTIONS,
  PermissionPolicy,
  type PermissionMode,
  modeState,
} from "./permissions.ts";
import { createPlanTool } from "./plan-tool.ts";
import { classifyToolCall } from "./tool-facts.ts";
import {
  assistantStopReasonToAcp,
  SessionProjection,
  type SessionUpdate,
  type TerminalOutputMode,
} from "./translate.ts";
import { createAcpUiContext } from "./ui-context.ts";

export interface ClientFeatures {
  /** Display-terminal `_meta` extension the client renders (`_meta.terminal_output[_delta]`). */
  terminalOutput: TerminalOutputMode;
  /** `clientCapabilities.elicitation.form` present. */
  formElicitation: boolean;
  /** `clientCapabilities.elicitation.url` present. */
  urlElicitation: boolean;
  /** `clientCapabilities.session.configOptions.boolean` present. */
  booleanConfigOptions: boolean;
  delegation: DelegationCapabilities;
}

export interface SessionOpenOptions {
  conn: AgentSideConnection;
  cwd: string;
  settings: Settings;
  modelRuntime: ModelRuntime;
  features: ClientFeatures;
  mcpServers: readonly McpServer[] | undefined;
  /** Existing pi session file to open (load/resume) or fork from. */
  sessionFile?: string;
  fork?: boolean;
  reason: "new" | "load" | "resume" | "fork";
}

interface Inflight {
  resolve: (reason: StopReason) => void;
  reject: (error: Error) => void;
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Placeholder theme for extensions that read `ctx.ui.theme` outside the TUI. */
function stubTheme(): AgentSession["resourceLoader"] extends { getThemes(): { themes: (infer T)[] } }
  ? T
  : never {
  const identity = (_: unknown, text?: string): string => (typeof text === "string" ? text : String(_));
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "name") return "acp";
        if (prop === "getColorMode") return () => "256color";
        if (prop === "getThinkingBorderColor" || prop === "getBashModeBorderColor")
          return () => (s: string) => s;
        if (prop === "getFgAnsi" || prop === "getBgAnsi") return () => "";
        return identity;
      },
    },
  ) as never;
}

export class PiAcpSession {
  readonly cwd: string;
  readonly conn: AgentSideConnection;
  readonly policy: PermissionPolicy;
  readonly projection: SessionProjection;

  private runtime!: AgentSessionRuntime;
  private readonly settings: Settings;
  private readonly features: ClientFeatures;
  private readonly mcpMounts: McpMount[] = [];
  private mcpDiagnostics: string[] = [];
  private eventBus: TappedEventBus | undefined;
  private unsubscribe: (() => void) | undefined;
  private inflight: Inflight | undefined;
  private cancelled = false;
  private closed = false;
  private lastEmit: Promise<void> = Promise.resolve();
  private _sessionId = "";
  private startupDiagnostics: string[] = [];

  private constructor(options: SessionOpenOptions) {
    this.cwd = options.cwd;
    this.conn = options.conn;
    this.settings = options.settings;
    this.features = options.features;
    this.policy = new PermissionPolicy(options.settings.permissionMode);
    this.projection = new SessionProjection({
      cwd: options.cwd,
      // A delegated client terminal owns the presentation; the display-terminal
      // extension only applies when pi runs the command itself.
      terminalOutput: options.features.delegation.terminal ? "none" : options.features.terminalOutput,
      files: { read: readFileOrNull },
    });
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get session(): AgentSession {
    return this.runtime.session;
  }

  get isRunning(): boolean {
    return this.inflight !== undefined;
  }

  get diagnostics(): string[] {
    return [...this.startupDiagnostics, ...this.mcpDiagnostics];
  }

  static async open(options: SessionOpenOptions): Promise<PiAcpSession> {
    const session = new PiAcpSession(options);
    await session.boot(options);
    return session;
  }

  // ------------------------------------------------------------------ //
  // Runtime creation                                                    //
  // ------------------------------------------------------------------ //

  private async boot(options: SessionOpenOptions): Promise<void> {
    const { settings, modelRuntime } = options;
    const agentDir = settings.agentDir ?? getAgentDir();
    const sessionDir = settings.sessionDir;

    let sessionManager: SessionManager;
    if (options.sessionFile !== undefined && options.fork === true) {
      sessionManager = SessionManager.forkFrom(options.sessionFile, this.cwd, sessionDir);
    } else if (options.sessionFile !== undefined) {
      sessionManager = SessionManager.open(options.sessionFile, sessionDir, this.cwd);
    } else {
      sessionManager = SessionManager.create(this.cwd, sessionDir);
    }
    this._sessionId = sessionManager.getSessionId();

    const mcp = await mountMcpServers(options.mcpServers, this.cwd);
    this.mcpMounts.push(...mcp.mounts);
    this.mcpDiagnostics = mcp.diagnostics;

    const gate: InlineExtension = {
      name: "openma-acp-permissions",
      factory: (pi: ExtensionAPI) => {
        pi.on("tool_call", (event) => this.policy.gate(event, (call) => this.requestToolPermission(call)));
      },
    };
    // Every `pi.events.emit` from any extension flows through here; see extension-events.ts.
    this.eventBus = createTappedEventBus((channel, data) => this.onExtensionEvent(channel, data));

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd,
      agentDir: dir,
      sessionManager: sm,
      sessionStartEvent,
    }) => {
      const trusted = this.resolveProjectTrust(cwd, dir);
      const settingsManager = SettingsManager.create(cwd, dir, { projectTrusted: trusted });
      const services = await createAgentSessionServices({
        cwd,
        agentDir: dir,
        settingsManager,
        modelRuntime,
        modelRuntimeSignal: AbortSignal.timeout(15_000),
        resourceLoaderOptions: { extensionFactories: [gate], eventBus: this.eventBus },
      });
      const customTools: ToolDefinition[] = [createPlanTool(), ...mcp.tools];
      if (settings.delegation) {
        customTools.push(
          ...createDelegatedTools({
            conn: this.conn,
            sessionId: this._sessionId,
            cwd,
            caps: this.features.delegation,
            autoResizeImages: settingsManager.getImageAutoResize(),
            onTerminal: (toolCallId, terminalId) => {
              const update = this.projection.attachClientTerminal(toolCallId, terminalId);
              if (update !== undefined) this.emit(update);
            },
          }),
        );
      }
      let model;
      let thinkingLevel: ThinkingLevel | undefined;
      if (settings.model !== undefined) {
        const resolved = resolveCliModel({ cliModel: settings.model, modelRuntime });
        if (resolved.error !== undefined) throw new Error(resolved.error);
        if (resolved.warning !== undefined) logWarn(resolved.warning);
        model = resolved.model;
        thinkingLevel = resolved.thinkingLevel;
      }
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: sm,
        sessionStartEvent,
        customTools,
        ...(model !== undefined ? { model } : {}),
        ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      });
      const diagnostics = [
        ...services.diagnostics,
        ...services.resourceLoader.getExtensions().errors.map(({ path, error }) => ({
          type: "error" as const,
          message: `Failed to load extension "${path}": ${error}`,
        })),
        ...(trusted || !hasTrustRequiringProjectResources(cwd)
          ? []
          : [
              {
                type: "warning" as const,
                message: `Project resources in ${cwd}/.pi were not loaded (untrusted). Run /trust to load them.`,
              },
            ]),
      ];
      return { ...created, services, diagnostics };
    };

    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: this.cwd,
      agentDir,
      sessionManager,
      ...(options.reason !== "new"
        ? {
            sessionStartEvent: {
              type: "session_start",
              reason: options.reason === "load" ? "resume" : options.reason,
            },
          }
        : {}),
    });
    this.runtime.setRebindSession(async () => this.bindSession());
    this.startupDiagnostics = this.runtime.diagnostics.map((d) => `${d.type}: ${d.message}`);
    if (this.runtime.modelFallbackMessage !== undefined)
      this.startupDiagnostics.push(this.runtime.modelFallbackMessage);
    await this.bindSession();
  }

  private resolveProjectTrust(cwd: string, agentDir: string): boolean {
    if (this.settings.trustProjects) return true;
    if (!hasTrustRequiringProjectResources(cwd)) return true;
    try {
      const store = new ProjectTrustStore(agentDir);
      const decision = store.get(cwd);
      if (decision !== null) return decision;
      const preference = SettingsManager.create(cwd, agentDir, {
        projectTrusted: false,
      }).getDefaultProjectTrust();
      return preference === "always";
    } catch (error: unknown) {
      logDebug(`project trust lookup failed: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Persist a trust decision for the session cwd and reload resources. */
  async trustProject(remember: boolean): Promise<void> {
    if (remember) {
      new ProjectTrustStore(this.runtime.services.agentDir).set(this.cwd, true);
    }
    this.settings.trustProjects = this.settings.trustProjects || !remember;
    await this.session.reload();
  }

  private async bindSession(): Promise<void> {
    this.unsubscribe?.();
    const session = this.runtime.session;
    const theme = session.resourceLoader.getThemes().themes[0] ?? stubTheme();
    await session.bindExtensions({
      uiContext: createAcpUiContext({
        conn: this.conn,
        sessionId: this._sessionId,
        emit: (update) => this.emit(update),
        formElicitation: () => this.features.formElicitation,
        theme,
      }),
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => this.session.waitForIdle(),
        newSession: async (options) => {
          const result = await this.runtime.newSession(options);
          if (!result.cancelled) await this.bindSession();
          return { cancelled: result.cancelled };
        },
        fork: async (entryId, options) => {
          const result = await this.runtime.fork(entryId, options);
          if (!result.cancelled) await this.bindSession();
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, options) => {
          const result = await this.session.navigateTree(targetId, options);
          return { cancelled: result.cancelled };
        },
        switchSession: async (sessionPath, options) => {
          const result = await this.runtime.switchSession(sessionPath, options);
          if (!result.cancelled) await this.bindSession();
          return result;
        },
        reload: async () => {
          await this.session.reload();
          this.publishCommands();
        },
      },
      shutdownHandler: () => {
        logDebug("extension requested shutdown; ignored in ACP mode");
      },
      onError: (error) => {
        this.emit({
          sessionUpdate: "session_info_update",
          _meta: piMeta({
            event: "extension_error",
            extensionPath: error.extensionPath,
            hook: error.event,
            error: error.error,
          }),
        });
      },
    });
    this.projection.setContextWindow(session.model?.contextWindow);
    this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
  }

  private onSessionEvent(event: AgentSessionEvent): void {
    for (const update of this.projection.onEvent(event)) this.emit(update);
    if (event.type === "agent_settled") this.settle();
  }

  private onExtensionEvent(channel: string, data: unknown): void {
    const facts = describeExtensionEvent(channel, data);
    this.emit({
      sessionUpdate: "session_info_update",
      _meta: piMeta({ event: "extension_event", inferred: true, ...facts }),
    });
  }

  /** Deliver an ACP-originated event to extensions (`_pi/emit_event`). */
  injectExtensionEvent(channel: string, data: unknown): void {
    this.eventBus?.inject(channel, data);
  }

  // ------------------------------------------------------------------ //
  // Emission                                                            //
  // ------------------------------------------------------------------ //

  emit(update: SessionUpdate): void {
    if (this.closed) return;
    this.lastEmit = this.lastEmit
      .then(() => this.conn.sessionUpdate({ sessionId: this._sessionId, update }))
      .catch((error: unknown) => {
        logDebug(`session/update failed: ${errorMessage(error)}`);
      });
  }

  flush(): Promise<void> {
    return this.lastEmit;
  }

  text(text: string): void {
    this.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  }

  // ------------------------------------------------------------------ //
  // Surfaces                                                            //
  // ------------------------------------------------------------------ //

  configOptions(): SessionConfigOption[] {
    return buildConfigOptions(this.session, this.policy.mode, {
      booleanOptions: this.features.booleanConfigOptions,
    });
  }

  modes(): ReturnType<typeof modeState> {
    return modeState(this.policy.mode);
  }

  availableCommands(): AvailableCommand[] {
    return availableCommandsFor(this.session, {
      enableSkillCommands: this.session.settingsManager.getEnableSkillCommands(),
    });
  }

  publishCommands(): void {
    this.emit({ sessionUpdate: "available_commands_update", availableCommands: this.availableCommands() });
  }

  publishConfigOptions(): void {
    this.emit({ sessionUpdate: "config_option_update", configOptions: this.configOptions() });
  }

  publishMode(): void {
    this.emit({ sessionUpdate: "current_mode_update", currentModeId: this.policy.mode });
  }

  replayHistory(): void {
    const replay = buildReplay(this.session.sessionManager.buildContextEntries(), this.cwd);
    for (const update of replay.updates) this.emit(update);
    if (replay.usage !== undefined) {
      this.emit({
        sessionUpdate: "session_info_update",
        _meta: piMeta({ event: "prompt_usage", usage: replay.usage }),
      });
    }
    const title = replay.title ?? this.session.sessionName;
    if (title !== undefined) {
      this.emit({ sessionUpdate: "session_info_update", title, updatedAt: new Date().toISOString() });
    }
  }

  setMode(mode: PermissionMode): void {
    this.policy.mode = mode;
    this.publishMode();
  }

  async setModel(value: string): Promise<void> {
    const models = [...this.session.modelRuntime.getAvailableSnapshot()];
    const model = findModel(models, value);
    if (model === undefined) throw invalidParams(`unknown model: ${value}`);
    if (this.session.model !== undefined && modelValue(this.session.model) === modelValue(model)) return;
    try {
      await this.session.setModel(model, { persist: true });
    } catch (error: unknown) {
      throw invalidParams(`cannot switch to ${value}: ${errorMessage(error)}`);
    }
    this.projection.setContextWindow(model.contextWindow);
  }

  setThinking(level: string): void {
    const levels = this.session.getAvailableThinkingLevels();
    if (!(levels as string[]).includes(level)) throw invalidParams(`unknown thinking level: ${level}`);
    this.session.setThinkingLevel(level as ThinkingLevel, { persist: true });
  }

  // ------------------------------------------------------------------ //
  // Permission requests                                                 //
  // ------------------------------------------------------------------ //

  private async requestToolPermission(
    event: ToolCallEvent,
  ): Promise<ReturnType<typeof decisionFromOptionId>> {
    const facts = classifyToolCall(event.toolName, event.input, this.cwd);
    const toolCall: ToolCallUpdate = {
      toolCallId: event.toolCallId,
      title: facts.title,
      kind: facts.kind,
      status: "pending",
      rawInput: event.input,
      ...(facts.locations.length > 0 ? { locations: facts.locations } : {}),
    };
    await this.flush();
    try {
      const response = await this.conn.requestPermission({
        sessionId: this._sessionId,
        toolCall,
        options: PERMISSION_OPTIONS,
      });
      if (response.outcome.outcome === "cancelled") return { decision: "cancelled", remember: false };
      return decisionFromOptionId(response.outcome.optionId);
    } catch (error: unknown) {
      logWarn(`permission request failed: ${errorMessage(error)}`);
      return { decision: "cancelled", remember: false };
    }
  }

  // ------------------------------------------------------------------ //
  // Prompt lifecycle                                                    //
  // ------------------------------------------------------------------ //

  /** Inject into the running turn (steer) — used by concurrent prompts and `_session/steering`. */
  async steer(text: string, images: Parameters<AgentSession["steer"]>[1]): Promise<void> {
    await this.session.steer(text, images);
  }

  async prompt(text: string, images: Parameters<AgentSession["steer"]>[1]): Promise<StopReason> {
    if (this.inflight !== undefined) {
      await this.steer(text, images);
      return "end_turn";
    }
    this.cancelled = false;
    this.projection.beginPrompt();
    this.projection.setContextWindow(this.session.model?.contextWindow);

    return new Promise<StopReason>((resolve, reject) => {
      const inflight: Inflight = { resolve, reject };
      this.inflight = inflight;
      let accepted = false;
      const run = this.session.prompt(text, {
        images: images !== undefined && images.length > 0 ? images : undefined,
        source: "rpc",
        preflightResult: (ok) => {
          accepted = ok;
        },
      });
      run.then(
        () => {
          // pi resolves prompt() after the full run; `agent_settled` normally settles
          // first, but a prompt that short-circuits (extension command, "handled"
          // input) never emits it.
          if (this.inflight === inflight && this.session.isIdle) this.settle();
        },
        (error: unknown) => {
          if (this.inflight !== inflight) return;
          this.inflight = undefined;
          const message = errorMessage(error);
          if (!accepted && looksLikeAuthError(error)) {
            inflight.reject(authRequired(message));
          } else if (!accepted) {
            inflight.reject(invalidParams(message));
          } else {
            inflight.reject(internalError(message));
          }
        },
      );
    });
  }

  private settle(): void {
    const inflight = this.inflight;
    if (inflight === undefined) return;
    this.inflight = undefined;
    const changes = this.projection.fileChanges();
    if (changes.length > 0) {
      this.emit({
        sessionUpdate: "session_info_update",
        _meta: piMeta({ event: "file_changes", files: changes }),
      });
    }
    const error = this.cancelled ? undefined : this.projection.promptError;
    const failureKind = error !== undefined ? classifyFailure(error) : undefined;
    if (error !== undefined && failureKind !== undefined) {
      this.emit({
        sessionUpdate: "session_info_update",
        _meta: piMeta({ event: "failure", kind: failureKind, message: error }),
      });
    }
    void this.flush().finally(() => {
      if (this.cancelled) {
        inflight.resolve("cancelled");
        return;
      }
      if (error !== undefined) {
        inflight.reject(
          failureKind === "auth_required"
            ? authRequired(error, piMeta({ assistantError: true, failure: failureKind }))
            : internalError(error, piMeta({ assistantError: true, failure: failureKind })),
        );
        return;
      }
      inflight.resolve(assistantStopReasonToAcp(this.projection.lastAssistant));
    });
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.session.clearQueue();
    this.session.abortBash();
    if (this.session.isCompacting) this.session.abortCompaction();
    if (this.session.isRetrying) this.session.abortRetry();
    try {
      await this.session.abort();
    } catch (error: unknown) {
      logDebug(`abort failed: ${errorMessage(error)}`);
    }
    this.projection.clearOpenToolCalls();
    // `agent_settled` follows the abort; settle defensively if it does not.
    if (this.inflight !== undefined && this.session.isIdle) this.settle();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.cancelled = true;
    try {
      await this.session.abort();
    } catch {
      // ignore
    }
    if (this.inflight !== undefined) this.settle();
    await this.flush();
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await Promise.allSettled(this.mcpMounts.map((mount) => mount.close()));
    try {
      await this.runtime.dispose();
    } catch (error: unknown) {
      logDebug(`runtime dispose failed: ${errorMessage(error)}`);
    }
  }
}
