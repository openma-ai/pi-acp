/**
 * In-process ACP harness: a `ClientSideConnection` talking to `PiAcpAgent` over
 * an in-memory stream pair, with a faux pi model provider (no network).
 */

import {
  AgentSideConnection,
  ClientSideConnection,
  type AnyMessage,
  type Client,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  InMemoryCredentialStore,
  type FauxProviderHandle,
  type FauxResponseStep,
  type Provider,
} from "@earendil-works/pi-ai";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAcpAgent } from "../../src/acp/agent.ts";
import { RequestIdTracker, tapRequestIds } from "../../src/acp/request-ids.ts";
import { resolveSettings, type Settings } from "../../src/settings.ts";

export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall };

function streamPair(): [Stream, Stream] {
  const aToB = new TransformStream<AnyMessage, AnyMessage>();
  const bToA = new TransformStream<AnyMessage, AnyMessage>();
  return [
    { writable: aToB.writable, readable: bToA.readable },
    { writable: bToA.writable, readable: aToB.readable },
  ];
}

export interface HarnessOptions {
  settings?: Partial<Settings>;
  clientCapabilities?: Record<string, unknown>;
  onPermission?: (
    request: RequestPermissionRequest,
  ) => RequestPermissionResponse | Promise<RequestPermissionResponse>;
  onElicitation?: (
    request: CreateElicitationRequest,
  ) => CreateElicitationResponse | Promise<CreateElicitationResponse>;
  readTextFile?: Client["readTextFile"];
  writeTextFile?: Client["writeTextFile"];
  /** Extra native providers registered on the model runtime before connecting. */
  providers?: Provider[];
}

export class Harness {
  readonly root: string;
  readonly agentDir: string;
  readonly workspace: string;
  readonly sessionDir: string;
  readonly faux: FauxProviderHandle;
  readonly modelRuntime: ModelRuntime;
  readonly notifications: SessionNotification[] = [];
  readonly permissionRequests: RequestPermissionRequest[] = [];
  readonly elicitations: CreateElicitationRequest[] = [];
  readonly completedElicitations: string[] = [];
  readonly extNotifications: { method: string; params: Record<string, unknown> }[] = [];
  client!: ClientSideConnection;
  agent!: PiAcpAgent;
  private agentConn!: AgentSideConnection;
  private readonly options: HarnessOptions;

  private constructor(options: HarnessOptions, faux: FauxProviderHandle, modelRuntime: ModelRuntime) {
    this.options = options;
    this.root = mkdtempSync(join(tmpdir(), "openma-pi-acp-"));
    this.agentDir = join(this.root, "agent");
    this.workspace = join(this.root, "work");
    this.sessionDir = join(this.root, "sessions");
    mkdirSync(this.agentDir, { recursive: true });
    mkdirSync(this.workspace, { recursive: true });
    mkdirSync(this.sessionDir, { recursive: true });
    writeFileSync(
      join(this.agentDir, "settings.json"),
      JSON.stringify({ quietStartup: true, retry: { enabled: false } }),
    );
    this.faux = faux;
    this.modelRuntime = modelRuntime;
  }

  static async create(options: HarnessOptions = {}): Promise<Harness> {
    const faux = fauxProvider({
      provider: "faux",
      models: [
        { id: "faux-1", name: "Faux One", reasoning: true, input: ["text", "image"], contextWindow: 100_000 },
        { id: "faux-2", name: "Faux Two", reasoning: false, input: ["text"], contextWindow: 50_000 },
      ],
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: true,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    for (const provider of options.providers ?? []) modelRuntime.registerNativeProvider(provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const harness = new Harness(options, faux, modelRuntime);
    harness.connect();
    return harness;
  }

  private connect(): void {
    const [clientStream, agentStream] = streamPair();
    const settings: Settings = {
      ...resolveSettings([]),
      agentDir: this.agentDir,
      sessionDir: this.sessionDir,
      quietStartup: true,
      model: "faux/faux-1",
      ...this.options.settings,
    };
    const requestIds = new RequestIdTracker();
    this.agentConn = new AgentSideConnection(
      (conn) => {
        this.agent = new PiAcpAgent(conn, { settings, modelRuntime: this.modelRuntime, requestIds });
        return this.agent;
      },
      tapRequestIds(agentStream, requestIds),
    );
    const harness = this;
    this.client = new ClientSideConnection(
      (): Client => ({
        sessionUpdate(params) {
          harness.notifications.push(params);
        },
        async requestPermission(params) {
          harness.permissionRequests.push(params);
          if (harness.options.onPermission !== undefined) return harness.options.onPermission(params);
          return { outcome: { outcome: "selected", optionId: "allow-once" } };
        },
        async createElicitation(params) {
          harness.elicitations.push(params);
          if (harness.options.onElicitation !== undefined) return harness.options.onElicitation(params);
          return { action: "cancel" };
        },
        async completeElicitation(params) {
          harness.completedElicitations.push(params.elicitationId);
        },
        async extNotification(method, params) {
          harness.extNotifications.push({ method, params });
        },
        ...(harness.options.readTextFile !== undefined ? { readTextFile: harness.options.readTextFile } : {}),
        ...(harness.options.writeTextFile !== undefined
          ? { writeTextFile: harness.options.writeTextFile }
          : {}),
      }),
      clientStream,
    );
  }

  respond(...steps: FauxResponseStep[]): void {
    this.faux.setResponses(steps);
  }

  async initialize(): Promise<Awaited<ReturnType<ClientSideConnection["initialize"]>>> {
    return this.client.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        ...(this.options.clientCapabilities ?? {}),
      } as never,
      clientInfo: { name: "harness", version: "0" },
    });
  }

  async newSession(mcpServers: never[] = []): Promise<string> {
    const response = await this.client.newSession({ cwd: this.workspace, mcpServers });
    return response.sessionId;
  }

  updatesFor(sessionId: string): SessionNotification["update"][] {
    return this.notifications.filter((n) => n.sessionId === sessionId).map((n) => n.update);
  }

  text(sessionId: string): string {
    return this.updatesFor(sessionId)
      .filter((u) => u.sessionUpdate === "agent_message_chunk" && u.content.type === "text")
      .map((u) =>
        u.sessionUpdate === "agent_message_chunk" && u.content.type === "text" ? u.content.text : "",
      )
      .join("");
  }

  async settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  async close(): Promise<void> {
    await this.agent?.dispose();
    rmSync(this.root, { recursive: true, force: true });
  }
}
