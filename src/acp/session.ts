/**
 * One ACP session ↔ one pi `AgentSessionRuntime`, in-process.
 *
 * Owns runtime creation (services, tools, extensions), event
 * projection to `session/update`, prompt lifecycle (inflight turn, steering,
 * cancellation), and teardown.
 */

import type {
  AgentSideConnection,
  AvailableCommand,
  McpServer,
  SessionConfigOption,
  StopReason,
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
  type ModelRuntime,
  type ToolDefinition,
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
import { extensionInventory, toolOwnerLookup, type ExtensionInventoryEntry } from "./extension-inventory.ts";
import { buildReplay } from "./history.ts";
import { piMeta } from "./meta.ts";
import { mountMcpServers, type McpMount } from "./mcp.ts";
import {
  assistantStopReasonToAcp,
  SessionProjection,
  type SessionUpdate,
  type TerminalOutputMode,
} from "./translate.ts";
import { createAcpUiContext } from "./ui-context.ts";
import {
  ADDITIONAL_DIRECTORIES_ENTRY,
  AdditionalDirectoriesError,
  additionalDirectoriesSupported,
  persistedAdditionalDirectoriesRecord,
  savedAdditionalDirectories,
  scopeExtensionLoaded,
  validateAdditionalDirectories,
  workspaceScopeExtension,
  WorkspaceScope,
  type DirectoryPlan,
} from "./workspace-scope.ts";

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
  /**
   * How ACP `additionalDirectories` apply. `cwd` stays the project root for
   * skills and AGENTS.md; these roots only widen filesystem scope.
   */
  directoryPlan: DirectoryPlan;
  /** Existing pi session file to open (load/resume) or fork from. */
  sessionFile?: string;
  fork?: boolean;
  reason: "new" | "load" | "resume" | "fork";
}

interface Inflight {
  settlement?: Promise<void>;
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
  readonly projection: SessionProjection;

  private runtime!: AgentSessionRuntime;
  private readonly settings: Settings;
  private readonly features: ClientFeatures;
  private resourceDiagnostics: string[] = [];
  private eventBus: TappedEventBus | undefined;
  private readonly scope: WorkspaceScope;
  private readonly directoryPlan: DirectoryPlan;
  private scopeReady = false;
  private unsubscribe: (() => void) | undefined;
  private inflight: Inflight | undefined;
  private cancelled = false;
  private readonly trustedProjects = new Set<string>();
  private closed = false;
  private deliveryError: Error | undefined;
  private closePromise: Promise<void> | undefined;
  private lastEmit: Promise<void> = Promise.resolve();
  private _sessionId = "";
  private startupDiagnostics: string[] = [];
  private mcpMounts: McpMount[] = [];

  private constructor(options: SessionOpenOptions) {
    this.cwd = options.cwd;
    this.conn = options.conn;
    this.settings = options.settings;
    this.features = options.features;
    this.scope = new WorkspaceScope(options.cwd);
    this.directoryPlan = options.directoryPlan;
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
    return [...this.startupDiagnostics, ...this.resourceDiagnostics];
  }

  /** Canonical additional roots currently in filesystem scope (not including `cwd`). */
  get additionalDirectories(): string[] {
    return this.scope.enforced ? this.scope.additionalDirectories : [];
  }

  /** True only when this session opted into the path boundary. */
  get additionalDirectoriesEnforced(): boolean {
    return this.scope.enforced;
  }

  /** Why a shell command is outside the session roots, if the boundary is on. */
  shellDenial(command: string): string | undefined {
    return this.scope.shellDenial(command);
  }

  /**
   * Grow the persisted root list (`_pi/add_directory`) and turn the boundary on.
   * Same policy as a lifecycle request: absolute, not a filesystem root, not `$HOME`, at most 16.
   */
  addAdditionalDirectory(filePath: string): string[] {
    if (!additionalDirectoriesSupported()) throw invalidParams("additionalDirectories are not available");
    if (!this.scopeReady) throw invalidParams("workspace scope is not loaded");
    let next: string[];
    try {
      next = validateAdditionalDirectories(
        [...(this.scope.enforced ? this.scope.additionalDirectories : []), filePath],
        this.cwd,
      );
    } catch (error: unknown) {
      if (error instanceof AdditionalDirectoriesError) throw invalidParams(error.message);
      throw error;
    }
    const changed = !this.scope.enforced || !sameDirectories(next, this.scope.additionalDirectories);
    this.scope.enforced = true;
    this.scope.setAdditional(next);
    if (changed) this.persistDirectoryRecord(next, true);
    return this.additionalDirectories;
  }

  static async open(options: SessionOpenOptions): Promise<PiAcpSession> {
    const session = new PiAcpSession(options);
    try {
      await session.boot(options);
      return session;
    } catch (error) {
      session.closed = true;
      session.unsubscribe?.();
      await session.runtime?.dispose().catch(() => undefined);
      await session.closeMcp();
      throw error;
    }
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
    this.mcpMounts = mcp.mounts;
    this.resourceDiagnostics.push(...mcp.diagnostics);

    // Every `pi.events.emit` from any extension flows through here; see extension-events.ts.
    this.eventBus = createTappedEventBus((channel, data) => this.onExtensionEvent(channel, data));
    const scopeEnabled = additionalDirectoriesSupported();

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
        resourceLoaderOptions: {
          eventBus: this.eventBus,
          ...(scopeEnabled ? { extensionFactories: [workspaceScopeExtension(this.scope)] } : {}),
        },
      });
      const customTools: ToolDefinition[] = [...mcp.tools];
      if (settings.delegation) {
        customTools.push(
          ...createDelegatedTools({
            conn: this.conn,
            sessionId: this._sessionId,
            cwd,
            caps: this.features.delegation,
            autoResizeImages: settingsManager.getImageAutoResize(),
            shellPath: settingsManager.getShellPath(),
            commandPrefix: settingsManager.getShellCommandPrefix(),
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
    this.installDirectories(scopeEnabled);
  }

  /**
   * Apply the lifecycle plan. The boundary stays off unless the client sent
   * `additionalDirectories` or `_meta.pi.restoreAdditionalDirectories`.
   */
  private installDirectories(scopeEnabled: boolean): void {
    const plan = this.directoryPlan;
    if (plan.warning !== undefined) {
      logWarn(plan.warning);
      this.resourceDiagnostics.push(`warning: ${plan.warning}`);
    }
    if (scopeEnabled) {
      const loaded = this.session.resourceLoader
        .getExtensions()
        .extensions.map((extension) => extension.path);
      this.scopeReady = scopeExtensionLoaded(loaded);
    }
    if (!scopeEnabled || plan.kind === "ignored" || plan.kind === "off") {
      this.scope.enforced = false;
      this.scope.setAdditional([]);
      if (scopeEnabled && plan.kind === "off") this.deactivateSavedDirectories();
      return;
    }
    if (!this.scopeReady) {
      throw internalError("workspace scope failed to load; refusing to enforce a path boundary");
    }
    let directories = plan.directories;
    if (plan.kind === "restore") {
      const saved = savedAdditionalDirectories(this.session.sessionManager.getBranch());
      try {
        directories = validateAdditionalDirectories(saved, this.cwd);
      } catch (error: unknown) {
        if (error instanceof AdditionalDirectoriesError) throw invalidParams(error.message);
        throw error;
      }
    }
    this.scope.enforced = true;
    this.scope.setAdditional(directories);
    this.persistDirectoryRecord(directories, true);
  }

  /** Keep the saved list for a later restore, but stop reporting or enforcing it. */
  private deactivateSavedDirectories(): void {
    const branch = this.session.sessionManager.getBranch();
    const record = persistedAdditionalDirectoriesRecord(branch);
    if (!record.enforced) return;
    this.persistDirectoryRecord(record.directories, false);
  }

  private persistDirectoryRecord(directories: readonly string[], enforced: boolean): void {
    const record = persistedAdditionalDirectoriesRecord(this.session.sessionManager.getBranch());
    if (record.enforced === enforced && sameDirectories(record.directories, directories)) return;
    this.session.sessionManager.appendCustomEntry(ADDITIONAL_DIRECTORIES_ENTRY, {
      directories: [...directories],
      enforced,
    });
  }

  private resolveProjectTrust(cwd: string, agentDir: string): boolean {
    if (this.settings.trustProjects || this.trustedProjects.has(cwd)) return true;
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
    this.trustedProjects.add(this.cwd);
    this.session.settingsManager.setProjectTrusted(true);
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
    this.projection.setToolOwner(toolOwnerLookup(session));
    this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
  }

  /** Loaded extensions with the tools/commands/custom types they own. */
  extensions(): ExtensionInventoryEntry[] {
    return extensionInventory(this.session);
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
    if (this.closed || this.deliveryError) return;
    this.lastEmit = this.lastEmit
      .then(() => {
        if (this.deliveryError) return;
        return this.conn.sessionUpdate({ sessionId: this._sessionId, update });
      })
      .catch((error: unknown) => {
        this.deliveryError ??= error instanceof Error ? error : new Error(String(error));
        logWarn(`session/update failed: ${errorMessage(error)}`);
      });
  }

  async flush(): Promise<void> {
    await this.lastEmit;
    if (this.deliveryError) throw this.deliveryError;
  }

  text(text: string): void {
    this.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  }

  // ------------------------------------------------------------------ //
  // Surfaces                                                            //
  // ------------------------------------------------------------------ //

  configOptions(): SessionConfigOption[] {
    return buildConfigOptions(this.session, {
      booleanOptions: this.features.booleanConfigOptions,
    });
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

  async setModel(value: string, options?: { persist?: boolean }): Promise<void> {
    const models = [...this.session.modelRuntime.getAvailableSnapshot()];
    const model = findModel(models, value);
    if (model === undefined) throw invalidParams(`unknown model: ${value}`);
    const unchanged =
      this.session.model !== undefined && modelValue(this.session.model) === modelValue(model);
    // Same model and no request to save a global default: leave pi's settings alone.
    if (unchanged && options?.persist !== true) return;
    try {
      // persist defaults to false in pi: session transcript only, not ~/.pi/agent/settings.json.
      await this.session.setModel(model, { persist: options?.persist === true });
    } catch (error: unknown) {
      throw invalidParams(`cannot switch to ${value}: ${errorMessage(error)}`);
    }
    this.projection.setContextWindow(model.contextWindow);
  }

  setThinking(level: string, options?: { persist?: boolean }): void {
    const levels = this.session.getAvailableThinkingLevels();
    if (!(levels as string[]).includes(level)) throw invalidParams(`unknown thinking level: ${level}`);
    this.session.setThinkingLevel(level as ThinkingLevel, { persist: options?.persist === true });
  }

  // ------------------------------------------------------------------ //
  // Prompt lifecycle                                                    //
  // ------------------------------------------------------------------ //

  /**
   * Pi steer: deliver after the current assistant turn finishes its tool calls,
   * before the next model call. Used by `_session/steering` and by a concurrent
   * `session/prompt`. A follow-up that should wait until the turn ends is a
   * later `session/prompt` from the client (pi's Alt+Enter), not this path.
   */
  async steer(text: string, images: Parameters<AgentSession["steer"]>[1]): Promise<void> {
    await this.session.steer(text, images);
  }

  async prompt(text: string, images: Parameters<AgentSession["steer"]>[1]): Promise<StopReason> {
    if (this.closed || this.closePromise) throw internalError("session is closing or closed");
    if (this.deliveryError) throw this.deliveryError;
    if (this.inflight?.settlement) {
      await this.inflight.settlement;
      return this.prompt(text, images);
    }
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
    if (inflight === undefined || inflight.settlement) return;
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
    const cancelled = this.cancelled;
    const stopReason = assistantStopReasonToAcp(this.projection.lastAssistant);
    inflight.settlement = this.flush()
      .then(
        () => {
          if (cancelled) inflight.resolve("cancelled");
          else if (error !== undefined)
            inflight.reject(
              failureKind === "auth_required"
                ? authRequired(error, piMeta({ assistantError: true, failure: failureKind }))
                : internalError(error, piMeta({ assistantError: true, failure: failureKind })),
            );
          else inflight.resolve(stopReason);
        },
        (failure: unknown) => {
          inflight.reject(internalError(`session delivery failed: ${errorMessage(failure)}`));
        },
      )
      .finally(() => {
        if (this.inflight === inflight) this.inflight = undefined;
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

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    if (this.closed) return;
    this.cancelled = true;
    try {
      await this.session.abort();
    } catch {
      // ignore
    }
    if (this.inflight !== undefined) this.settle();
    await this.flush().catch((error: unknown) => logDebug(`close delivery failed: ${errorMessage(error)}`));
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    try {
      await this.runtime.dispose();
    } catch (error: unknown) {
      logDebug(`runtime dispose failed: ${errorMessage(error)}`);
    }
    await this.closeMcp();
  }

  private async closeMcp(): Promise<void> {
    const mounts = this.mcpMounts.splice(0);
    await Promise.allSettled(mounts.map((mount) => mount.close()));
  }
}

function sameDirectories(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((dir, index) => dir === right[index]);
}
