/**
 * Extension event bus → ACP.
 *
 * pi extensions talk to each other over `pi.events` (free-form channel names,
 * arbitrary payloads). The adapter cannot know what an extension means, but the
 * traffic has observable regularities that clients can use to build a
 * "work item with a lifecycle" view without understanding the domain:
 *
 * - channel names are `<namespace>:<noun>-<phase>` (`subagent:async-started`,
 *   `subagent:process-terminal`, `herdr:busy`) — the trailing token often names
 *   a lifecycle phase;
 * - payloads carry a correlation id under a handful of conventional keys
 *   (`id`, `runId`, `taskId`, `requestId`, `pid`, …).
 *
 * Every event is forwarded as `session_info_update` metadata with those two
 * inferences attached and explicitly marked `inferred: true`. Nothing here is
 * promoted to a first-class ACP update: the adapter reports evidence, not
 * semantics.
 */

import { createEventBus, type EventBus, type EventBusController } from "@earendil-works/pi-coding-agent";

export type InferredPhase =
  "started" | "update" | "completed" | "failed" | "cancelled" | "request" | "response";

export interface ExtensionEventFacts {
  channel: string;
  namespace: string;
  /** Channel with the namespace stripped. */
  name: string;
  phase?: InferredPhase;
  correlationId?: string;
  /** JSON-safe, size-bounded copy of the payload. */
  payload: unknown;
  /** True when `payload` was truncated or had non-serializable parts dropped. */
  truncated: boolean;
}

const PHASE_WORDS: Record<InferredPhase, readonly string[]> = {
  started: ["started", "start", "spawned", "spawn", "created", "create", "begin", "began", "opened", "open"],
  update: ["update", "updated", "progress", "status", "delta", "tick", "heartbeat", "busy", "notice"],
  completed: [
    "complete",
    "completed",
    "done",
    "finished",
    "finish",
    "success",
    "succeeded",
    "terminal",
    "exit",
    "exited",
    "ended",
    "end",
    "closed",
    "close",
    "settled",
  ],
  failed: ["failed", "fail", "failure", "error", "errored", "crashed", "blocked"],
  cancelled: ["cancel", "cancelled", "canceled", "aborted", "abort", "stop", "stopped", "killed"],
  request: ["request", "ask"],
  response: ["response", "reply", "result", "ack", "acknowledge"],
};

const CORRELATION_KEYS = [
  "id",
  "runId",
  "taskId",
  "jobId",
  "childId",
  "requestId",
  "asyncId",
  "workflowId",
  "sessionId",
  "pid",
] as const;

const MAX_PAYLOAD_CHARS = 8_000;
const MAX_DEPTH = 6;

export function inferPhase(name: string): InferredPhase | undefined {
  const tokens = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
  // Trailing token first, then earlier ones (`slash:started` vs `async-started-late`).
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i]!;
    for (const [phase, words] of Object.entries(PHASE_WORDS) as [InferredPhase, readonly string[]][]) {
      if (words.includes(token)) return phase;
    }
  }
  return undefined;
}

export function inferCorrelationId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of CORRELATION_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 200) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** Deep copy keeping only JSON values; drops functions, class instances' prototypes, cycles. */
export function sanitizePayload(value: unknown): { payload: unknown; truncated: boolean } {
  let truncated = false;
  const seen = new WeakSet<object>();
  const walk = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (typeof input === "bigint") return input.toString();
    if (typeof input === "undefined" || typeof input === "function" || typeof input === "symbol") {
      truncated = true;
      return undefined;
    }
    if (typeof input !== "object") return undefined;
    if (seen.has(input)) {
      truncated = true;
      return "[circular]";
    }
    if (depth >= MAX_DEPTH) {
      truncated = true;
      return Array.isArray(input) ? `[array ${input.length}]` : "[object]";
    }
    seen.add(input);
    if (input instanceof Date) return input.toISOString();
    if (input instanceof Error) return { name: input.name, message: input.message };
    if (Array.isArray(input)) return input.map((item) => walk(item, depth + 1) ?? null);
    if (typeof (input as { then?: unknown }).then === "function") {
      truncated = true;
      return "[promise]";
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      const walked = walk(item, depth + 1);
      if (walked !== undefined) out[key] = walked;
    }
    return out;
  };
  let payload = walk(value, 0);
  let text: string;
  try {
    text = JSON.stringify(payload) ?? "null";
  } catch {
    return { payload: "[unserializable]", truncated: true };
  }
  if (text.length > MAX_PAYLOAD_CHARS) {
    truncated = true;
    payload = { _truncated: true, preview: text.slice(0, MAX_PAYLOAD_CHARS) };
  }
  return { payload, truncated };
}

export function describeExtensionEvent(channel: string, data: unknown): ExtensionEventFacts {
  const separator = channel.search(/[:.]/);
  const namespace = separator > 0 ? channel.slice(0, separator) : "pi";
  const name = separator > 0 ? channel.slice(separator + 1) : channel;
  const { payload, truncated } = sanitizePayload(data);
  const phase = inferPhase(name);
  const correlationId = inferCorrelationId(data);
  return {
    channel,
    namespace,
    name,
    ...(phase !== undefined ? { phase } : {}),
    ...(correlationId !== undefined ? { correlationId } : {}),
    payload,
    truncated,
  };
}

export interface TappedEventBus extends EventBusController {
  /** Emit from the adapter side (e.g. ACP control requests) without echoing back to the tap. */
  inject(channel: string, data: unknown): void;
}

/**
 * An `EventBus` for `resourceLoaderOptions.eventBus` that observes every emit.
 * The observer must not throw; failures are swallowed so extensions never see them.
 */
export function createTappedEventBus(observe: (channel: string, data: unknown) => void): TappedEventBus {
  const inner: EventBusController = createEventBus();
  return {
    emit(channel, data) {
      try {
        observe(channel, data);
      } catch {
        // observers are best-effort
      }
      inner.emit(channel, data);
    },
    on: (channel, handler) => inner.on(channel, handler),
    clear: () => inner.clear(),
    inject: (channel, data) => inner.emit(channel, data),
  } satisfies EventBus & TappedEventBus;
}
