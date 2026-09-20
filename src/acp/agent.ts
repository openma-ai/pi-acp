/**
 * The ACP `Agent` implementation: protocol methods over a map of live pi sessions.
 */

import {
  PROTOCOL_VERSION,
  RequestError,
  type Agent as AcpAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type DeleteSessionRequest,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type LogoutRequest,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { existsSync, unlinkSync } from "node:fs";
import { isAbsolute } from "node:path";
import { errorMessage, logDebug, logWarn } from "../log.ts";
import type { Settings } from "../settings.ts";
import { AGENT_NAME, AGENT_TITLE, VERSION } from "../version.ts";
import { AuthFlowCancelled, createAcpAuthInteraction } from "./auth-interaction.ts";
import {
  AUTH_STATUS_META_KEY,
  AUTH_STATUS_UPDATE_METHOD,
  computeAuthStatus,
  sameAuthStatus,
  type AuthStatus,
} from "./auth-status.ts";
import {
  apiKeyFromAuthenticate,
  buildAuthMethods,
  parseAuthMethodId,
  TERMINAL_AUTH_METHOD_ID,
  type AuthMethodOptions,
} from "./auth.ts";
import { runBuiltinCommand } from "./builtin-commands.ts";
import { isBuiltinCommand, parseSlashCommand } from "./commands.ts";
import {
  CONFIG_AUTO_COMPACTION,
  CONFIG_MODE,
  CONFIG_MODEL,
  CONFIG_THINKING,
  parseBooleanOptionValue,
} from "./config-options.ts";
import { delegationFromClient } from "./delegation.ts";
import { authRequired, internalError, invalidParams } from "./errors.ts";
import { piMeta, readPiMeta } from "./meta.ts";
import { isPermissionMode } from "./permissions.ts";
import { convertPrompt, UnsupportedPromptContentError } from "./prompt.ts";
import type { RequestIdTracker } from "./request-ids.ts";
import { detectFromSettings } from "./extensions/registry.ts";
import { COLLABORATION_MODE_OPTION, PLAN_COMMAND } from "./extensions/plannotator.ts";
import { PiAcpSession, type ClientFeatures } from "./session.ts";
import { findSession, listSessions, toAcpSessionInfo } from "./sessions-index.ts";
import { buildStartupInfo } from "./startup-info.ts";

const LIST_PAGE_SIZE = 100;
/** Upper bound for an interactive provider login (browser round trip, device code polling). */
const AUTH_FLOW_TIMEOUT_MS = 10 * 60 * 1000;
/** Legacy extension method some clients still send instead of `session/set_config_option`. */
const LEGACY_SET_MODEL_METHOD = "session/set_model";

export interface PiAcpAgentOptions {
  settings: Settings;
  /** Injected for tests; created from the agent dir otherwise. */
  modelRuntime?: ModelRuntime;
  /** Inbound request ids (needed for request-scoped elicitation during `authenticate`). */
  requestIds?: RequestIdTracker;
}

export class PiAcpAgent implements AcpAgent {
  private readonly conn: AgentSideConnection;
  private readonly settings: Settings;
  private readonly sessions = new Map<string, PiAcpSession>();
  private readonly opening = new Map<string, Promise<PiAcpSession>>();
  private modelRuntimePromise: Promise<ModelRuntime> | undefined;
  private readonly requestIds: RequestIdTracker | undefined;
  private features: ClientFeatures = {
    terminalOutput: "none",
    formElicitation: false,
    urlElicitation: false,
    booleanConfigOptions: false,
    delegation: { readTextFile: false, writeTextFile: false, terminal: false },
  };
  private terminalAuthMeta = false;
  private lastAuthStatus: AuthStatus | undefined;
  private closed = false;

  constructor(conn: AgentSideConnection, options: PiAcpAgentOptions) {
    this.conn = conn;
    this.settings = options.settings;
    this.requestIds = options.requestIds;
    if (options.modelRuntime !== undefined) this.modelRuntimePromise = Promise.resolve(options.modelRuntime);
  }

  private authMethodOptions(): AuthMethodOptions {
    return {
      terminalAuthMeta: this.terminalAuthMeta,
      urlElicitation: this.features.urlElicitation,
      formElicitation: this.features.formElicitation,
    };
  }

  /** Push `_auth/status_update` when pi's credential picture changed since the last push. */
  private async publishAuthStatus(): Promise<void> {
    if (this.closed) return;
    let modelRuntime: ModelRuntime;
    try {
      modelRuntime = await this.modelRuntime();
    } catch {
      return;
    }
    const status = computeAuthStatus(modelRuntime);
    if (sameAuthStatus(this.lastAuthStatus, status)) return;
    this.lastAuthStatus = status;
    try {
      await this.conn.extNotification(AUTH_STATUS_UPDATE_METHOD, { authStatus: status });
    } catch (error: unknown) {
      logDebug(`${AUTH_STATUS_UPDATE_METHOD} failed: ${errorMessage(error)}`);
    }
  }

  get agentDir(): string {
    return this.settings.agentDir ?? getAgentDir();
  }

  private get sessionDir(): string | undefined {
    if (this.settings.sessionDir !== undefined) return this.settings.sessionDir;
    try {
      return SettingsManager.create(process.cwd(), this.agentDir).getSessionDir();
    } catch {
      return undefined;
    }
  }

  private modelRuntime(): Promise<ModelRuntime> {
    this.modelRuntimePromise ??= ModelRuntime.create({
      authPath: `${this.agentDir}/auth.json`,
      modelsPath: `${this.agentDir}/models.json`,
      signal: AbortSignal.timeout(15_000),
    });
    return this.modelRuntimePromise;
  }

  // ------------------------------------------------------------------ //
  // Lifecycle                                                           //
  // ------------------------------------------------------------------ //

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const live = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(live.map((session) => session.close()));
  }

  private assertOpen(): void {
    if (this.closed) throw internalError("the ACP agent has been disposed");
  }

  private requireSession(sessionId: string): PiAcpSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw invalidParams(`unknown session: ${sessionId}`);
    return session;
  }

  /** Live session, else silently restored from pi's store (clients keep threads across restarts). */
  private async requireOrRestore(sessionId: string): Promise<PiAcpSession> {
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return live;
    const inflight = this.opening.get(sessionId);
    if (inflight !== undefined) return inflight;
    const stored = await findSession(sessionId, this.sessionDir);
    if (stored === undefined) throw invalidParams(`unknown session: ${sessionId}`);
    logWarn(`restoring session ${sessionId} from ${stored.path}`);
    return this.openSession({
      cwd: stored.cwd,
      sessionFile: stored.path,
      reason: "resume",
      mcpServers: undefined,
      sessionId,
    });
  }

  private async openSession(params: {
    cwd: string;
    sessionFile?: string;
    fork?: boolean;
    reason: "new" | "load" | "resume" | "fork";
    mcpServers: readonly NewSessionRequest["mcpServers"][number][] | undefined;
    additionalDirectories?: readonly string[] | null;
    sessionId?: string;
  }): Promise<PiAcpSession> {
    const key = params.sessionId ?? `pending:${params.cwd}:${params.sessionFile ?? "new"}:${Date.now()}`;
    const promise = (async () => {
      const modelRuntime = await this.modelRuntime();
      const existing = params.sessionId !== undefined ? this.sessions.get(params.sessionId) : undefined;
      if (existing !== undefined) {
        this.sessions.delete(params.sessionId!);
        await existing.close();
      }
      const session = await PiAcpSession.open({
        conn: this.conn,
        cwd: params.cwd,
        settings: this.settings,
        modelRuntime,
        features: this.features,
        mcpServers: params.mcpServers,
        ...(params.additionalDirectories ? { additionalDirectories: params.additionalDirectories } : {}),
        ...(params.sessionFile !== undefined ? { sessionFile: params.sessionFile } : {}),
        ...(params.fork !== undefined ? { fork: params.fork } : {}),
        reason: params.reason,
      });
      if (this.closed) {
        await session.close();
        throw internalError("connection closed while opening the session");
      }
      this.sessions.set(session.sessionId, session);
      return session;
    })();
    this.opening.set(key, promise);
    try {
      return await promise;
    } finally {
      this.opening.delete(key);
    }
  }

  private async requireModel(session: PiAcpSession): Promise<void> {
    const pi = session.session;
    const modelRuntime = await this.modelRuntime();
    if (pi.model !== undefined && modelRuntime.hasConfiguredAuth(pi.model.provider)) return;
    if (pi.model !== undefined && (await modelRuntime.checkAuth(pi.model.provider)) !== undefined) return;
    const available = modelRuntime.getAvailableSnapshot();
    if (pi.model === undefined && available.length > 0) {
      await pi.setModel(available[0]!);
      return;
    }
    throw authRequired(
      pi.model === undefined || available.length === 0
        ? "no model is available: log in with pi (terminal auth) or provide an API key"
        : `no credentials for provider "${pi.model.provider}": log in with pi or provide an API key`,
      { authMethods: buildAuthMethods(modelRuntime, this.authMethodOptions()) },
    );
  }

  private async publishSurfaces(session: PiAcpSession, options: { startup?: boolean } = {}): Promise<void> {
    // Clients ignore notifications for a session id they have not seen yet; wait a tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.publishCommands();
    if (options.startup === true && this.settings.quietStartup !== true) {
      const quiet = session.session.settingsManager.getQuietStartup();
      if (!quiet) session.text(buildStartupInfo(session.session, session.diagnostics));
    }
  }

  // ------------------------------------------------------------------ //
  // Protocol                                                            //
  // ------------------------------------------------------------------ //

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    const caps = params.clientCapabilities;
    const meta = (caps as { _meta?: Record<string, unknown> } | undefined)?._meta;
    const present = (value: unknown): boolean => value !== undefined && value !== null;
    this.features = {
      terminalOutput:
        meta?.["terminal_output"] === true
          ? "terminal_output"
          : meta?.["terminal_output_delta"] === true
            ? "terminal_output_delta"
            : "none",
      formElicitation: present(caps?.elicitation?.form),
      urlElicitation: present(caps?.elicitation?.url),
      booleanConfigOptions: present(caps?.session?.configOptions?.boolean),
      delegation: this.settings.delegation
        ? delegationFromClient(caps)
        : { readTextFile: false, writeTextFile: false, terminal: false },
    };
    this.terminalAuthMeta = meta?.["terminal-auth"] === true;
    let modelRuntime: ModelRuntime | undefined;
    try {
      modelRuntime = await this.modelRuntime();
    } catch (error: unknown) {
      logWarn(`model runtime unavailable at initialize: ${errorMessage(error)}`);
    }
    const knownAtStartup = detectFromSettings(process.cwd(), this.agentDir);
    const requested = params.protocolVersion;
    const response: InitializeResponse = {
      protocolVersion:
        typeof requested === "number" && requested >= 1 && requested < PROTOCOL_VERSION
          ? requested
          : PROTOCOL_VERSION,
      agentInfo: { name: AGENT_NAME, title: AGENT_TITLE, version: VERSION },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: false },
        sessionCapabilities: {
          list: {},
          delete: {},
          fork: {},
          resume: {},
          close: {},
          // Only when pi-add-dir is installed: the adapter has no multi-root primitive of its own.
          ...(knownAtStartup.has("pi-add-dir") ? { additionalDirectories: {} } : {}),
        },
        auth: { logout: {} },
        _meta: {
          ...piMeta({ version: VERSION, delegation: this.features.delegation }),
          // Presence announces that this agent pushes `_auth/status_update`.
          [AUTH_STATUS_META_KEY]: {},
        },
      },
      authMethods: buildAuthMethods(modelRuntime, this.authMethodOptions()),
      _meta: { steering: { supported: true } },
    };
    // After the response: clients ignore notifications that arrive before it.
    setTimeout(() => void this.publishAuthStatus(), 0);
    return response;
  }

  async authenticate(params: AuthenticateRequest): Promise<void> {
    try {
      await this.runAuthenticate(params);
    } finally {
      void this.publishAuthStatus();
    }
  }

  private async runAuthenticate(params: AuthenticateRequest): Promise<void> {
    const modelRuntime = await this.modelRuntime();
    if (params.methodId === TERMINAL_AUTH_METHOD_ID) {
      // Terminal auth runs out of band (`--terminal-login`); refresh what pi stored.
      await modelRuntime.refresh({ allowNetwork: false });
      return;
    }
    const submitted = apiKeyFromAuthenticate(params._meta);
    const parsed = parseAuthMethodId(params.methodId);
    const provider = submitted.provider ?? parsed?.provider;
    if (provider === undefined) throw invalidParams(`unknown auth method: ${params.methodId}`);

    if (parsed?.type === "oauth" && submitted.apiKey === undefined) {
      await this.oauthLogin(modelRuntime, provider);
      return;
    }
    if (submitted.apiKey === undefined) {
      if (modelRuntime.hasConfiguredAuth(provider)) return;
      throw authRequired(`authenticate ${params.methodId} requires _meta["api-key"].apiKey`);
    }
    const apiKey = submitted.apiKey;
    try {
      await modelRuntime.login(provider, "api_key", {
        prompt: async () => apiKey,
        notify: (event) => logDebug(`login[${provider}] ${event.type}`),
      });
    } catch (error: unknown) {
      logWarn(
        `persisting API key for ${provider} failed (${errorMessage(error)}); using it for this process only`,
      );
      await modelRuntime.setRuntimeApiKey(provider, apiKey);
    }
  }

  /** Run pi's provider OAuth flow, delivering URLs/codes/prompts through ACP elicitation. */
  private async oauthLogin(modelRuntime: ModelRuntime, provider: string): Promise<void> {
    if (modelRuntime.getProvider(provider)?.auth.oauth === undefined)
      throw invalidParams(`provider "${provider}" has no OAuth login`);
    const requestId = this.requestIds?.latestFor("authenticate");
    if (requestId === undefined)
      throw internalError("OAuth login needs the authenticate request id (request tracking is not wired)");
    if (!this.features.urlElicitation && !this.features.formElicitation)
      throw authRequired("OAuth login needs a client that supports URL or form elicitation");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_FLOW_TIMEOUT_MS);
    const interaction = createAcpAuthInteraction({
      conn: this.conn,
      requestId,
      provider,
      urlElicitation: this.features.urlElicitation,
      formElicitation: this.features.formElicitation,
      signal: controller.signal,
    });
    try {
      await modelRuntime.login(provider, "oauth", interaction);
    } catch (error: unknown) {
      if (error instanceof AuthFlowCancelled || controller.signal.aborted) {
        throw authRequired(`login with ${provider} was cancelled`);
      }
      throw authRequired(`login with ${provider} failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
      controller.abort();
      await interaction.finish();
    }
    await modelRuntime.refresh({ allowNetwork: false });
  }

  async logout(_params: LogoutRequest): Promise<void> {
    const modelRuntime = await this.modelRuntime();
    const credentials = await modelRuntime.listCredentials();
    for (const credential of credentials) {
      try {
        await modelRuntime.logout(credential.providerId);
      } catch (error: unknown) {
        logWarn(`logout ${credential.providerId} failed: ${errorMessage(error)}`);
      }
    }
    void this.publishAuthStatus();
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.assertOpen();
    validateCwd(params.cwd);
    const session = await this.openSession({
      cwd: params.cwd,
      reason: "new",
      mcpServers: params.mcpServers,
      additionalDirectories: params.additionalDirectories,
    });
    try {
      await this.requireModel(session);
    } catch (error: unknown) {
      this.sessions.delete(session.sessionId);
      const file = session.session.sessionFile;
      await session.close();
      if (file !== undefined && existsSync(file)) {
        try {
          unlinkSync(file);
        } catch {
          // best effort: an empty session file is harmless
        }
      }
      throw error;
    }
    void this.publishSurfaces(session, { startup: true });
    return {
      sessionId: session.sessionId,
      modes: session.modes(),
      configOptions: session.configOptions(),
      _meta: piMeta({
        sessionFile: session.session.sessionFile ?? null,
        diagnostics: session.diagnostics,
        extensions: session.extensions(),
        additionalDirectories: session.additionalDirectories,
      }),
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.assertOpen();
    validateCwd(params.cwd);
    const stored = await findSession(params.sessionId, this.sessionDir);
    if (stored === undefined) throw invalidParams(`unknown session: ${params.sessionId}`);
    const session = await this.openSession({
      cwd: params.cwd,
      sessionFile: stored.path,
      reason: "load",
      mcpServers: params.mcpServers,
      additionalDirectories: params.additionalDirectories,
      sessionId: params.sessionId,
    });
    session.replayHistory();
    await this.requireModel(session).catch((error: unknown) => {
      logWarn(`loaded session ${params.sessionId} without a usable model: ${errorMessage(error)}`);
    });
    void this.publishSurfaces(session);
    return {
      modes: session.modes(),
      configOptions: session.configOptions(),
      _meta: piMeta({
        sessionFile: stored.path,
        diagnostics: session.diagnostics,
        extensions: session.extensions(),
        additionalDirectories: session.additionalDirectories,
      }),
    };
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    this.assertOpen();
    validateCwd(params.cwd);
    const stored = await findSession(params.sessionId, this.sessionDir);
    if (stored === undefined) throw invalidParams(`unknown session: ${params.sessionId}`);
    const session = await this.openSession({
      cwd: params.cwd,
      sessionFile: stored.path,
      reason: "resume",
      mcpServers: params.mcpServers,
      additionalDirectories: params.additionalDirectories,
      sessionId: params.sessionId,
    });
    await this.requireModel(session).catch((error: unknown) => {
      logWarn(`resumed session ${params.sessionId} without a usable model: ${errorMessage(error)}`);
    });
    void this.publishSurfaces(session);
    return {
      modes: session.modes(),
      configOptions: session.configOptions(),
      _meta: piMeta({
        sessionFile: stored.path,
        diagnostics: session.diagnostics,
        extensions: session.extensions(),
        additionalDirectories: session.additionalDirectories,
      }),
    };
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    this.assertOpen();
    validateCwd(params.cwd);
    const live = this.sessions.get(params.sessionId);
    const sourceFile =
      live?.session.sessionFile ?? (await findSession(params.sessionId, this.sessionDir))?.path;
    if (sourceFile === undefined) throw invalidParams(`unknown session: ${params.sessionId}`);
    const session = await this.openSession({
      cwd: params.cwd,
      sessionFile: sourceFile,
      fork: true,
      reason: "fork",
      mcpServers: params.mcpServers ?? undefined,
      additionalDirectories: params.additionalDirectories,
    });
    await this.requireModel(session).catch((error: unknown) => {
      logWarn(`forked session without a usable model: ${errorMessage(error)}`);
    });
    void this.publishSurfaces(session);
    return {
      sessionId: session.sessionId,
      modes: session.modes(),
      configOptions: session.configOptions(),
      _meta: piMeta({
        sessionFile: session.session.sessionFile ?? null,
        forkedFrom: params.sessionId,
        extensions: session.extensions(),
        additionalDirectories: session.additionalDirectories,
      }),
    };
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    this.assertOpen();
    const entries = await listSessions({
      ...(params.cwd !== undefined && params.cwd !== null ? { cwd: params.cwd } : {}),
      ...(this.sessionDir !== undefined ? { sessionDir: this.sessionDir } : {}),
    });
    const offset =
      params.cursor !== undefined && params.cursor !== null ? Number.parseInt(params.cursor, 10) : 0;
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const page = entries.slice(start, start + LIST_PAGE_SIZE);
    return {
      sessions: page.map(toAcpSessionInfo),
      nextCursor: start + LIST_PAGE_SIZE < entries.length ? String(start + LIST_PAGE_SIZE) : null,
    };
  }

  async deleteSession(params: DeleteSessionRequest): Promise<void> {
    const live = this.sessions.get(params.sessionId);
    let file = live?.session.sessionFile;
    if (live !== undefined) {
      this.sessions.delete(params.sessionId);
      await live.close();
    }
    file ??= (await findSession(params.sessionId, this.sessionDir))?.path;
    if (file !== undefined && existsSync(file)) {
      try {
        unlinkSync(file);
      } catch (error: unknown) {
        throw internalError(`could not delete session file: ${errorMessage(error)}`);
      }
    }
  }

  async closeSession(params: CloseSessionRequest): Promise<void> {
    const live = this.sessions.get(params.sessionId);
    if (live === undefined) return;
    this.sessions.delete(params.sessionId);
    await live.close();
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    this.assertOpen();
    const session = await this.requireOrRestore(params.sessionId);
    let converted;
    try {
      converted = convertPrompt(params.prompt, {
        images: session.session.model?.input.includes("image") ?? true,
      });
    } catch (error: unknown) {
      if (error instanceof UnsupportedPromptContentError) throw invalidParams(error.message);
      throw error;
    }
    if (converted.text.trim().length === 0 && converted.images.length === 0)
      throw invalidParams("empty prompt");

    // Adapter built-ins never reach the model; pi handles its own slash commands
    // (extension commands, prompt templates, /skill:name) inside `prompt()`.
    const slash = converted.images.length === 0 ? parseSlashCommand(converted.text) : undefined;
    if (slash !== undefined && slash.name === PLAN_COMMAND && session.knownExtensions.has("plannotator")) {
      if (session.isRunning) {
        session.text("⚠ /plan is unavailable while a turn is running.");
        return { stopReason: "end_turn" };
      }
      const phase = await session.setCollaborationMode("plan");
      session.text(phase === "planning" ? "Plan mode on (Plannotator)." : `Plannotator phase: ${phase}.`);
      session.publishConfigOptions();
      await session.flush();
      return { stopReason: "end_turn" };
    }
    if (slash !== undefined && isBuiltinCommand(slash.name)) {
      if (session.isRunning && !["status", "queue", "mode", "session"].includes(slash.name)) {
        session.text(`⚠ /${slash.name} is unavailable while a turn is running.`);
        return { stopReason: "end_turn" };
      }
      const outcome = await runBuiltinCommand(session, slash.name, slash.args);
      if (outcome !== undefined) {
        session.text(outcome.text);
        if (outcome.refresh?.title !== undefined) {
          session.emit({
            sessionUpdate: "session_info_update",
            title: outcome.refresh.title,
            updatedAt: new Date().toISOString(),
          });
        }
        if (outcome.refresh?.mode === true) session.publishMode();
        if (outcome.refresh?.config === true) session.publishConfigOptions();
        if (outcome.refresh?.commands === true) session.publishCommands();
        await session.flush();
        return { stopReason: "end_turn" };
      }
    }

    if (!session.isRunning) await this.requireModel(session);
    const stopReason = await session.prompt(converted.text, converted.images);
    const usage = session.projection.promptUsage();
    return { stopReason, ...(usage !== undefined ? { usage } : {}) };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (session === undefined) return;
    await session.cancel();
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = await this.requireOrRestore(params.sessionId);
    if (!isPermissionMode(params.modeId)) throw invalidParams(`unknown mode: ${params.modeId}`);
    session.setMode(params.modeId);
    session.publishConfigOptions();
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = await this.requireOrRestore(params.sessionId);
    const value = params.value;
    switch (params.configId) {
      case CONFIG_MODE: {
        if (typeof value !== "string" || !isPermissionMode(value))
          throw invalidParams(`unknown mode: ${String(value)}`);
        session.setMode(value);
        break;
      }
      case CONFIG_MODEL: {
        if (typeof value !== "string") throw invalidParams("model must be a string");
        if (session.isRunning) throw invalidParams("cannot switch models while a turn is running");
        await session.setModel(value);
        break;
      }
      case CONFIG_THINKING: {
        if (typeof value !== "string") throw invalidParams("thinking level must be a string");
        session.setThinking(value);
        break;
      }
      case CONFIG_AUTO_COMPACTION: {
        const enabled = parseBooleanOptionValue(value);
        if (enabled === undefined) throw invalidParams("auto_compaction must be a boolean or on/off");
        session.session.setAutoCompactionEnabled(enabled);
        break;
      }
      case COLLABORATION_MODE_OPTION: {
        if (typeof value !== "string") throw invalidParams("collaboration_mode must be a string");
        if (session.isRunning) throw invalidParams("cannot change plan mode while a turn is running");
        await session.setCollaborationMode(value);
        break;
      }
      default:
        throw invalidParams(`unknown config option: ${params.configId}`);
    }
    return { configOptions: session.configOptions() };
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === "_session/steering") return this.steering(params);
    if (method === "_pi/trust_project") return this.trustProject(params);
    if (method === "_pi/emit_event") return this.emitEvent(params);
    if (method === LEGACY_SET_MODEL_METHOD) return this.legacySetModel(params);
    throw RequestError.methodNotFound(method);
  }

  /** `session/set_model` (pre-config-option clients): `{ sessionId, modelId }`. */
  private async legacySetModel(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = params["sessionId"];
    const modelId = params["modelId"];
    if (typeof sessionId !== "string" || typeof modelId !== "string")
      throw invalidParams(`${LEGACY_SET_MODEL_METHOD} requires sessionId and modelId`);
    const session = await this.requireOrRestore(sessionId);
    if (session.isRunning) throw invalidParams("cannot switch models while a turn is running");
    await session.setModel(modelId);
    session.publishConfigOptions();
    return {};
  }

  /** `_session/steering`: inject into the running turn; never starts a detached turn. */
  private async steering(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = params["sessionId"];
    if (typeof sessionId !== "string" || sessionId.length === 0)
      throw invalidParams("_session/steering requires a sessionId");
    const session = await this.requireOrRestore(sessionId);
    const prompt = Array.isArray(params["prompt"]) ? (params["prompt"] as PromptRequest["prompt"]) : [];
    if (prompt.length === 0) throw invalidParams("empty prompt");
    let converted;
    try {
      converted = convertPrompt(prompt);
    } catch (error: unknown) {
      if (error instanceof UnsupportedPromptContentError) throw invalidParams(error.message);
      throw error;
    }
    void readPiMeta(params["_meta"]);
    if (!session.isRunning) return { outcome: "promptRequired", reason: "noRunningTurn" };
    try {
      await session.steer(converted.text, converted.images);
    } catch (error: unknown) {
      throw internalError(`steering failed: ${errorMessage(error)}`);
    }
    return { outcome: "injected" };
  }

  /** `_pi/emit_event`: publish on the session's extension event bus (the reverse of `extension_event`). */
  private async emitEvent(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = params["sessionId"];
    const channel = params["channel"];
    if (
      typeof sessionId !== "string" ||
      sessionId.length === 0 ||
      typeof channel !== "string" ||
      channel.length === 0
    )
      throw invalidParams("_pi/emit_event requires sessionId and channel");
    const session = await this.requireOrRestore(sessionId);
    session.injectExtensionEvent(channel, params["data"]);
    return {};
  }

  /** `_pi/trust_project`: trust the session cwd (optionally remembered) and reload resources. */
  private async trustProject(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = params["sessionId"];
    if (typeof sessionId !== "string" || sessionId.length === 0)
      throw invalidParams("_pi/trust_project requires a sessionId");
    const session = await this.requireOrRestore(sessionId);
    await session.trustProject(params["remember"] === true);
    session.publishCommands();
    return { trusted: true };
  }
}

function validateCwd(cwd: string): void {
  if (!isAbsolute(cwd)) throw invalidParams(`cwd must be an absolute path: ${cwd}`);
  if (!existsSync(cwd)) throw invalidParams(`cwd does not exist: ${cwd}`);
}
