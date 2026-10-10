/**
 * The ACP `Agent` implementation: protocol methods over a map of live pi sessions.
 */

import {
  PROTOCOL_VERSION,
  RequestError,
  type Agent as AcpAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
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
  type LogoutResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { errorMessage, logDebug, logWarn } from "../log.ts";
import type { Settings } from "../settings.ts";
import { AGENT_NAME, AGENT_TITLE, VERSION } from "../version.ts";
import { AuthFlowCancelled, createAcpAuthInteraction } from "./auth-interaction.ts";
import { captureApiKeyViaUrl } from "./auth-loopback.ts";
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
  GATEWAY_METHOD_ID,
  gatewayFromAuthenticate,
  logoutScopeFromMeta,
  parseAuthMethodId,
  TERMINAL_AUTH_METHOD_ID,
  terminalLaunchSpec,
  type AuthMethodOptions,
} from "./auth.ts";
import { runBuiltinCommand } from "./builtin-commands.ts";
import { isBuiltinCommand, isNativeAuthCommand, parseSlashCommand } from "./commands.ts";
import {
  CONFIG_AUTO_COMPACTION,
  CONFIG_MODEL,
  CONFIG_THINKING,
  parseBooleanOptionValue,
} from "./config-options.ts";
import { delegationFromClient } from "./delegation.ts";
import { authRequired, internalError, invalidParams } from "./errors.ts";
import { acpInclusiveForkCapabilityMeta, mergeCapabilityMeta } from "./fork-capability.ts";
import { forkInclusiveSession, forkPointNotFoundMessage, parseJetbrainsAirFork } from "./fork-point.ts";
import { piMeta, readPiMeta } from "./meta.ts";
import { convertPrompt, UnsupportedPromptContentError } from "./prompt.ts";
import type { RequestIdTracker } from "./request-ids.ts";
import { PiAcpSession, type ClientFeatures } from "./session.ts";
import { findSession, listSessions, toAcpSessionInfo } from "./sessions-index.ts";
import { buildStartupInfo } from "./startup-info.ts";
import {
  AdditionalDirectoriesError,
  additionalDirectoriesCapability,
  additionalDirectoriesSupported,
  resolveAdditionalDirectoriesRequest,
  type DirectoryPlan,
} from "./workspace-scope.ts";

const LIST_PAGE_SIZE = 100;
/** Upper bound for an interactive provider login (browser round trip, device code polling). */
const AUTH_FLOW_TIMEOUT_MS = 10 * 60 * 1000;
/** Legacy extension method some clients still send instead of `session/set_config_option`. */
const LEGACY_SET_MODEL_METHOD = "session/set_model";
/** Grow the persisted additional-root list of a live session. */
const ADD_DIRECTORY_METHOD = "_pi/add_directory";

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
  private readonly openGenerations = new Map<string, number>();
  private nextOpenId = 0;
  private readonly pendingOpens = new Set<Promise<PiAcpSession>>();
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
  private terminalAuth = false;
  private gatewayAuth = false;
  /** Providers whose API key lives only in this process (persistence failed). */
  private readonly runtimeKeys = new Set<string>();
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
      terminal: this.terminalAuth,
      gateway: this.gatewayAuth,
      terminalAuthMeta: this.terminalAuthMeta,
      urlElicitation: this.features.urlElicitation,
      formElicitation: this.features.formElicitation,
    };
  }

  /** -32000 auth_required whose data always carries the current authMethods. */
  private authError(modelRuntime: ModelRuntime, message: string): RequestError {
    return authRequired(message, {
      authMethods: buildAuthMethods(modelRuntime, this.authMethodOptions()),
    });
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
    if (!this.modelRuntimePromise) {
      const pending = ModelRuntime.create({
        authPath: `${this.agentDir}/auth.json`,
        modelsPath: `${this.agentDir}/models.json`,
        signal: AbortSignal.timeout(15_000),
      });
      this.modelRuntimePromise = pending;
      void pending.catch(() => {
        if (this.modelRuntimePromise === pending) this.modelRuntimePromise = undefined;
      });
    }
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
    await Promise.allSettled([...live.map((session) => session.close()), ...this.pendingOpens]);
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
      directoryPlan: directoryPlanOf(undefined, stored.cwd, undefined),
      sessionId,
    });
  }

  private async openSession(params: {
    cwd: string;
    sessionFile?: string;
    fork?: boolean;
    reason: "new" | "load" | "resume" | "fork";
    mcpServers: readonly NewSessionRequest["mcpServers"][number][] | undefined;
    directoryPlan: DirectoryPlan;
    sessionId?: string;
  }): Promise<PiAcpSession> {
    const key = params.sessionId ?? `pending:${++this.nextOpenId}`;
    const generation = (this.openGenerations.get(key) ?? 0) + 1;
    this.openGenerations.set(key, generation);
    const isCurrent = () => !this.closed && this.openGenerations.get(key) === generation;
    const promise = (async () => {
      const modelRuntime = await this.modelRuntime();
      if (!isCurrent()) throw internalError("session open was superseded or closed");
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
        directoryPlan: params.directoryPlan,
        ...(params.sessionFile !== undefined ? { sessionFile: params.sessionFile } : {}),
        ...(params.fork !== undefined ? { fork: params.fork } : {}),
        reason: params.reason,
      });
      if (!isCurrent()) {
        await session.close();
        throw internalError("session open was superseded or closed");
      }
      this.sessions.set(session.sessionId, session);
      return session;
    })();
    this.opening.set(key, promise);
    this.pendingOpens.add(promise);
    try {
      return await promise;
    } finally {
      this.pendingOpens.delete(promise);
      if (this.opening.get(key) === promise) this.opening.delete(key);
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
    this.terminalAuth = caps?.auth?.terminal === true;
    this.gatewayAuth = caps?.auth?._meta?.["gateway"] === true;
    let modelRuntime: ModelRuntime | undefined;
    try {
      modelRuntime = await this.modelRuntime();
    } catch (error: unknown) {
      logWarn(`model runtime unavailable at initialize: ${errorMessage(error)}`);
    }
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
          // Present only when the path boundary is real (see workspace-scope.ts).
          ...(additionalDirectoriesCapability() !== undefined ? { additionalDirectories: {} } : {}),
        },
        auth: { logout: {} },
        _meta: mergeCapabilityMeta(
          {
            ...piMeta({ version: VERSION, delegation: this.features.delegation }),
            // Presence announces that this agent pushes `_auth/status_update`.
            [AUTH_STATUS_META_KEY]: {},
          },
          acpInclusiveForkCapabilityMeta(),
        ),
      },
      authMethods: buildAuthMethods(modelRuntime, this.authMethodOptions()),
      _meta: { steering: { supported: true } },
    };
    // After the response: clients ignore notifications that arrive before it.
    setTimeout(() => void this.publishAuthStatus(), 0);
    return response;
  }

  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    try {
      return await this.runAuthenticate(params);
    } finally {
      void this.publishAuthStatus();
    }
  }

  /** What the client just authenticated — reported back so the UI can show the active account. */
  private authResult(modelRuntime: ModelRuntime, provider: string, kind: string): AuthenticateResponse {
    return {
      _meta: piMeta({ auth: { provider, kind }, authStatus: computeAuthStatus(modelRuntime) }),
    };
  }

  private async storeApiKey(modelRuntime: ModelRuntime, provider: string, apiKey: string): Promise<void> {
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
      this.runtimeKeys.add(provider);
    }
  }

  private async runAuthenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    const modelRuntime = await this.modelRuntime();
    if (params.methodId === TERMINAL_AUTH_METHOD_ID) {
      // Terminal auth runs out of band; the spec forbids passing terminal methods
      // to authenticate, so reject it instead of silently accepting (masks client bugs).
      const launch = terminalLaunchSpec();
      throw invalidParams(
        `"${TERMINAL_AUTH_METHOD_ID}" is a terminal auth method — run \`${launch.command} ${launch.args.join(" ")}\` ` +
          "(or the client's terminal-auth launch spec); ACP clients must not send it to authenticate",
      );
    }
    if (params.methodId === GATEWAY_METHOD_ID) {
      return this.gatewayAuthenticate(modelRuntime, params);
    }
    const submitted = apiKeyFromAuthenticate(params._meta);
    const parsed = parseAuthMethodId(params.methodId);
    const provider = submitted.provider ?? parsed?.provider;
    if (provider === undefined) throw invalidParams(`unknown auth method: ${params.methodId}`);

    if (parsed?.type === "oauth" && submitted.apiKey === undefined) {
      await this.oauthLogin(modelRuntime, provider);
      return this.authResult(modelRuntime, provider, "oauth");
    }
    if (submitted.apiKey === undefined) {
      if (modelRuntime.hasConfiguredAuth(provider)) {
        // Re-authenticate over an existing credential is a no-op; report what is active.
        const kind = modelRuntime.isUsingOAuth(provider) ? "oauth" : "api_key";
        return this.authResult(modelRuntime, provider, kind);
      }
      // Spec-compliant secret path: a loopback key-entry page behind a URL elicitation.
      if (this.features.urlElicitation) {
        await this.urlLogin(modelRuntime, provider);
        return this.authResult(modelRuntime, provider, "api_key");
      }
      const launch = terminalLaunchSpec();
      throw this.authError(
        modelRuntime,
        `authenticate ${params.methodId} needs the key another way: send ` +
          `_meta["api-key"] = {"apiKey": "<key>"} (openma extension), use a client that supports ` +
          `URL elicitation, or run \`${launch.command} ${launch.args.join(" ")}\` to log in`,
      );
    }
    await this.storeApiKey(modelRuntime, provider, submitted.apiKey);
    return this.authResult(modelRuntime, provider, "api_key");
  }

  /** `_meta.gateway` → a models.json provider entry, then refresh so pi serves it. */
  private async gatewayAuthenticate(
    modelRuntime: ModelRuntime,
    params: AuthenticateRequest,
  ): Promise<AuthenticateResponse> {
    const parsed = gatewayFromAuthenticate(params._meta);
    if (parsed === undefined) {
      throw invalidParams(
        `authenticate methodId "${GATEWAY_METHOD_ID}" requires ` +
          '_meta.gateway = {"baseUrl": "https://…", "headers"?: {"Authorization": "Bearer <key>"}, "providerName"?: "…"}',
      );
    }
    if ("error" in parsed) throw invalidParams(parsed.error);
    const gw = parsed.submission;
    const patch: Record<string, unknown> = {
      baseUrl: gw.baseUrl,
      api: gw.api ?? "openai-completions",
      ...(gw.name !== undefined ? { name: gw.name } : {}),
      ...(gw.apiKey !== undefined ? { apiKey: gw.apiKey } : {}),
      ...(Object.keys(gw.headers).length > 0 ? { headers: gw.headers } : {}),
      ...(gw.models !== undefined ? { models: gw.models } : {}),
    };
    this.writeModelsJsonProvider(gw.provider, patch);
    await modelRuntime.refresh({ allowNetwork: false });
    return this.authResult(modelRuntime, gw.provider, "gateway");
  }

  /** Merge `patch` into `providers[providerId]` in `<agentDir>/models.json`. */
  private writeModelsJsonProvider(providerId: string, patch: Record<string, unknown>): void {
    const path = join(this.agentDir, "models.json");
    let doc: Record<string, unknown> = {};
    if (existsSync(path)) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch (error: unknown) {
        throw internalError(`cannot parse ${path}: ${errorMessage(error)}`);
      }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw internalError(`${path} must contain a JSON object`);
      }
      doc = raw as Record<string, unknown>;
    }
    const providers =
      typeof doc["providers"] === "object" && doc["providers"] !== null
        ? { ...(doc["providers"] as Record<string, unknown>) }
        : {};
    const existing = providers[providerId];
    providers[providerId] = {
      ...(typeof existing === "object" && existing !== null ? (existing as Record<string, unknown>) : {}),
      ...patch,
    };
    try {
      mkdirSync(this.agentDir, { recursive: true });
      writeFileSync(path, JSON.stringify({ ...doc, providers }, null, 2) + "\n");
    } catch (error: unknown) {
      throw internalError(`cannot write ${path}: ${errorMessage(error)}`);
    }
  }

  /**
   * Drop the provider's credential material from models.json (`apiKey` plus
   * Authorization/x-api-key headers). Returns true when something was removed.
   */
  private scrubModelsJsonAuth(providerId: string): boolean {
    const path = join(this.agentDir, "models.json");
    if (!existsSync(path)) return false;
    let doc: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
      doc = raw as Record<string, unknown>;
    } catch {
      return false;
    }
    const providers = doc["providers"];
    if (providers === null || typeof providers !== "object") return false;
    const providerMap = providers as Record<string, unknown>;
    const existing = providerMap[providerId];
    if (existing === null || typeof existing !== "object") return false;
    const next = { ...(existing as Record<string, unknown>) };
    let removed = false;
    if ("apiKey" in next) {
      delete next["apiKey"];
      removed = true;
    }
    const headers = next["headers"];
    if (headers !== null && typeof headers === "object") {
      const kept: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
        const lower = name.toLowerCase();
        if (lower === "authorization" || lower === "x-api-key") removed = true;
        else kept[name] = value;
      }
      if (Object.keys(kept).length === 0) delete next["headers"];
      else next["headers"] = kept;
    }
    if (!removed) return false;
    if (Object.keys(next).length === 0) delete providerMap[providerId];
    else providerMap[providerId] = next;
    try {
      writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
    } catch (error: unknown) {
      logWarn(`could not update ${path}: ${errorMessage(error)}`);
      return false;
    }
    return true;
  }

  /** Provider ids whose credential can actually be removed (store, runtime, or models.json). */
  private async removableProviders(modelRuntime: ModelRuntime): Promise<string[]> {
    const removable = new Set<string>();
    for (const credential of await modelRuntime.listCredentials()) {
      removable.add(credential.providerId);
    }
    for (const provider of this.runtimeKeys) removable.add(provider);
    const path = join(this.agentDir, "models.json");
    if (existsSync(path)) {
      try {
        const doc = JSON.parse(readFileSync(path, "utf8")) as {
          providers?: Record<string, { apiKey?: unknown; headers?: Record<string, unknown> }>;
        };
        for (const [id, config] of Object.entries(doc.providers ?? {})) {
          if (
            config !== null &&
            typeof config === "object" &&
            (config.apiKey !== undefined ||
              Object.keys(config.headers ?? {}).some(
                (name) => name.toLowerCase() === "authorization" || name.toLowerCase() === "x-api-key",
              ))
          ) {
            removable.add(id);
          }
        }
      } catch {
        // unreadable models.json: just report the credential-store providers
      }
    }
    return [...removable];
  }

  /**
   * Which provider a bare `logout` targets: the configured model's provider
   * (settings `--model`/settings.json `defaultProvider`), else the only
   * provider with a removable credential.
   */
  private async defaultLogoutProvider(modelRuntime: ModelRuntime): Promise<string | undefined> {
    const configured = this.settings.model?.split("/")[0] ?? this.settingsDefaultProvider();
    if (configured !== undefined) return configured;
    const removable = await this.removableProviders(modelRuntime);
    return removable.length === 1 ? removable[0] : undefined;
  }

  private settingsDefaultProvider(): string | undefined {
    try {
      return SettingsManager.create(process.cwd(), this.agentDir).getDefaultProvider();
    } catch {
      return undefined;
    }
  }

  /** Remove one provider's credential everywhere it can live. */
  private async logoutProvider(modelRuntime: ModelRuntime, provider: string): Promise<boolean> {
    let removed = false;
    const stored = await modelRuntime.listCredentials();
    if (stored.some((credential) => credential.providerId === provider)) {
      try {
        await modelRuntime.logout(provider);
        removed = true;
      } catch (error: unknown) {
        logWarn(`logout ${provider} failed: ${errorMessage(error)}`);
      }
    }
    if (this.runtimeKeys.delete(provider)) {
      try {
        await modelRuntime.removeRuntimeApiKey(provider);
      } catch (error: unknown) {
        logWarn(`removing runtime key for ${provider} failed: ${errorMessage(error)}`);
      }
      removed = true;
    }
    if (this.scrubModelsJsonAuth(provider)) removed = true;
    return removed;
  }

  /** API-key entry through a loopback page opened by a URL elicitation. */
  private async urlLogin(modelRuntime: ModelRuntime, provider: string): Promise<void> {
    const requestId = this.requestIds?.latestFor("authenticate");
    if (requestId === undefined) {
      throw internalError("URL login needs the authenticate request id (request tracking is not wired)");
    }
    const providerName = modelRuntime.getProvider(provider)?.name ?? provider;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_FLOW_TIMEOUT_MS);
    try {
      const apiKey = await captureApiKeyViaUrl({
        conn: this.conn,
        requestId,
        provider: providerName,
        signal: controller.signal,
      });
      await this.storeApiKey(modelRuntime, provider, apiKey);
    } catch (error: unknown) {
      if (error instanceof AuthFlowCancelled || controller.signal.aborted) {
        throw this.authError(modelRuntime, `login with ${providerName} was cancelled`);
      }
      throw this.authError(modelRuntime, `login with ${providerName} failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
      controller.abort();
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
      throw this.authError(modelRuntime, "OAuth login needs a client that supports URL or form elicitation");
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
        throw this.authError(modelRuntime, `login with ${provider} was cancelled`);
      }
      throw this.authError(modelRuntime, `login with ${provider} failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
      controller.abort();
      await interaction.finish();
    }
    await modelRuntime.refresh({ allowNetwork: false });
  }

  async logout(params: LogoutRequest): Promise<LogoutResponse> {
    try {
      return await this.runLogout(params);
    } finally {
      void this.publishAuthStatus();
    }
  }

  private async runLogout(params: LogoutRequest): Promise<LogoutResponse> {
    const modelRuntime = await this.modelRuntime();
    const scope = logoutScopeFromMeta(params._meta);
    let targets: string[];
    if (scope.all === true) {
      targets = await this.removableProviders(modelRuntime);
    } else {
      const provider = scope.provider ?? (await this.defaultLogoutProvider(modelRuntime));
      if (provider === undefined) {
        const removable = await this.removableProviders(modelRuntime);
        throw invalidParams(
          `logout needs a scope — pass _meta.pi.logout = {"provider": "<id>"} ` +
            (removable.length > 0 ? `(signed in: ${removable.join(", ")}) ` : "") +
            `or {"all": true} to sign out of every provider`,
        );
      }
      targets = [provider];
    }
    const cleared: string[] = [];
    for (const provider of targets) {
      if (await this.logoutProvider(modelRuntime, provider)) cleared.push(provider);
    }
    await modelRuntime.refresh({ allowNetwork: false });
    return {
      _meta: piMeta({ logout: { cleared }, authStatus: computeAuthStatus(modelRuntime) }),
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.assertOpen();
    validateCwd(params.cwd);
    const session = await this.openSession({
      cwd: params.cwd,
      reason: "new",
      mcpServers: params.mcpServers,
      directoryPlan: directoryPlanOf(params.additionalDirectories, params.cwd, params._meta),
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
      configOptions: session.configOptions(),
      _meta: piMeta({
        sessionFile: session.session.sessionFile ?? null,
        diagnostics: session.diagnostics,
        extensions: session.extensions(),
        ...directoryEcho(session),
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
      directoryPlan: directoryPlanOf(params.additionalDirectories, params.cwd, params._meta),
      sessionId: params.sessionId,
    });
    session.replayHistory();
    await session.flush();
    await this.requireModel(session).catch((error: unknown) => {
      logWarn(`loaded session ${params.sessionId} without a usable model: ${errorMessage(error)}`);
    });
    void this.publishSurfaces(session);
    return {
      configOptions: session.configOptions(),
      _meta: piMeta({
        sessionFile: stored.path,
        diagnostics: session.diagnostics,
        extensions: session.extensions(),
        ...directoryEcho(session),
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
      directoryPlan: directoryPlanOf(params.additionalDirectories, params.cwd, params._meta),
      sessionId: params.sessionId,
    });
    await this.requireModel(session).catch((error: unknown) => {
      logWarn(`resumed session ${params.sessionId} without a usable model: ${errorMessage(error)}`);
    });
    void this.publishSurfaces(session);
    return {
      configOptions: session.configOptions(),
      _meta: piMeta({
        sessionFile: stored.path,
        diagnostics: session.diagnostics,
        extensions: session.extensions(),
        ...directoryEcho(session),
      }),
    };
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    this.assertOpen();
    validateCwd(params.cwd);
    const parsed = parseJetbrainsAirFork(params._meta);
    if (parsed.status === "invalid") throw invalidParams(parsed.message);
    const live = this.sessions.get(params.sessionId);
    const sourceFile =
      live?.session.sessionFile ?? (await findSession(params.sessionId, this.sessionDir))?.path;
    if (sourceFile === undefined) throw invalidParams(`unknown session: ${params.sessionId}`);

    let sessionFile = sourceFile;
    let fork = true;
    if (parsed.status === "present") {
      let branched: string | undefined;
      try {
        branched = forkInclusiveSession(sourceFile, params.cwd, this.sessionDir, parsed.request);
      } catch (error: unknown) {
        throw internalError(`inclusive fork failed: ${errorMessage(error)}`);
      }
      if (branched === undefined) {
        throw invalidParams(forkPointNotFoundMessage(parsed.request.messageId, params.sessionId), {
          messageId: parsed.request.messageId,
        });
      }
      sessionFile = branched;
      fork = false;
    }

    const session = await this.openSession({
      cwd: params.cwd,
      sessionFile,
      fork,
      reason: "fork",
      mcpServers: params.mcpServers ?? undefined,
      directoryPlan: directoryPlanOf(params.additionalDirectories, params.cwd, params._meta),
    });
    await this.requireModel(session).catch((error: unknown) => {
      logWarn(`forked session without a usable model: ${errorMessage(error)}`);
    });
    void this.publishSurfaces(session);
    return {
      sessionId: session.sessionId,
      configOptions: session.configOptions(),
      _meta: piMeta({
        sessionFile: session.session.sessionFile ?? null,
        forkedFrom: params.sessionId,
        extensions: session.extensions(),
        ...directoryEcho(session),
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
    this.openGenerations.set(params.sessionId, (this.openGenerations.get(params.sessionId) ?? 0) + 1);
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
    this.openGenerations.set(params.sessionId, (this.openGenerations.get(params.sessionId) ?? 0) + 1);
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

    // pi's native auth commands (/login, /logout) are never advertised and
    // never reach the model: the turn ends with auth_required + data.authMethods
    // so the client shows its auth UI. Adapter built-ins likewise never reach
    // the model; pi handles its other slash commands inside `prompt()`.
    const slash = converted.images.length === 0 ? parseSlashCommand(converted.text) : undefined;
    if (slash !== undefined && isNativeAuthCommand(slash.name)) {
      const modelRuntime = await this.modelRuntime();
      throw this.authError(
        modelRuntime,
        `"/${slash.name}" is a pi terminal command with no effect over ACP — ` +
          "authenticate and sign out through the ACP authenticate/logout methods " +
          "(see data.authMethods); credentials are unchanged",
      );
    }
    if (slash !== undefined && isBuiltinCommand(slash.name)) {
      if (session.isRunning && !["status", "queue", "session"].includes(slash.name)) {
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
        if (outcome.refresh?.config === true) session.publishConfigOptions();
        if (outcome.refresh?.commands === true) session.publishCommands();
        await session.flush();
        return { stopReason: "end_turn" };
      }
    }

    if (!session.isRunning) await this.requireModel(session);
    let stopReason;
    try {
      stopReason = await session.prompt(converted.text, converted.images);
    } catch (error: unknown) {
      throw await this.enrichAuthError(error);
    }
    const usage = session.projection.promptUsage();
    return { stopReason, ...(usage !== undefined ? { usage } : {}) };
  }

  /** Every auth-related -32000 carries data.authMethods — attach it when pi's didn't. */
  private async enrichAuthError(error: unknown): Promise<unknown> {
    const e = error as { code?: unknown; data?: unknown };
    if (e.code !== RequestError.authRequired().code) return error;
    const modelRuntime = await this.modelRuntime();
    return authRequired((error as Error).message, {
      ...(e.data as Record<string, unknown> | undefined),
      authMethods: buildAuthMethods(modelRuntime, this.authMethodOptions()),
    });
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (session === undefined) return;
    await session.cancel();
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = await this.requireOrRestore(params.sessionId);
    const value = params.value;
    switch (params.configId) {
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
      default:
        throw invalidParams(`unknown config option: ${params.configId}`);
    }
    return { configOptions: session.configOptions() };
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === "_session/steering") return this.steering(params);
    if (method === "_pi/trust_project") return this.trustProject(params);
    if (method === ADD_DIRECTORY_METHOD) return this.addDirectory(params);
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
    // Backchat sends `_meta.steering.idleBehavior: "promptRequired"`. Idle never
    // starts a turn; the client follows up with `session/prompt` after this one ends.
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

  /** `_pi/add_directory`: append one root to a live session and persist it. */
  private async addDirectory(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!additionalDirectoriesSupported()) throw invalidParams("additionalDirectories are not available");
    const sessionId = params["sessionId"];
    const path = params["path"];
    if (
      typeof sessionId !== "string" ||
      sessionId.length === 0 ||
      typeof path !== "string" ||
      path.length === 0
    ) {
      throw invalidParams(`${ADD_DIRECTORY_METHOD} requires sessionId and path`);
    }
    const session = await this.requireOrRestore(sessionId);
    return { additionalDirectories: session.addAdditionalDirectory(path) };
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

function directoryEcho(session: PiAcpSession): {
  additionalDirectories: string[];
  additionalDirectoriesEnforced: boolean;
} {
  return {
    additionalDirectories: session.additionalDirectories,
    additionalDirectoriesEnforced: session.additionalDirectoriesEnforced,
  };
}

function directoryPlanOf(
  requested: readonly string[] | null | undefined,
  cwd: string,
  meta: unknown,
): DirectoryPlan {
  const omitted = requested === undefined || requested === null;
  const restore = omitted && readPiMeta(meta)?.["restoreAdditionalDirectories"] === true;
  try {
    return resolveAdditionalDirectoriesRequest(requested, cwd, {
      supported: additionalDirectoriesSupported(),
      restore,
    });
  } catch (error: unknown) {
    if (error instanceof AdditionalDirectoriesError) throw invalidParams(error.message);
    throw error;
  }
}
