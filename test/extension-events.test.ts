import { describe, expect, it } from "vitest";
import {
  createTappedEventBus,
  describeExtensionEvent,
  inferCorrelationId,
  inferPhase,
  sanitizePayload,
} from "../src/acp/extension-events.ts";

describe("extension event inference", () => {
  it("reads a lifecycle phase from channel naming conventions", () => {
    expect(inferPhase("async-started")).toBe("started");
    expect(inferPhase("process-terminal")).toBe("completed");
    expect(inferPhase("async-complete")).toBe("completed");
    expect(inferPhase("slash:update")).toBe("update");
    expect(inferPhase("watchdog.status")).toBe("update");
    expect(inferPhase("busy")).toBe("update");
    expect(inferPhase("blocked")).toBe("failed");
    expect(inferPhase("slash:cancel")).toBe("cancelled");
    expect(inferPhase("delegation:request")).toBe("request");
    expect(inferPhase("delegation:response")).toBe("response");
    expect(inferPhase("something-else")).toBeUndefined();
  });

  it("picks a correlation id from conventional keys", () => {
    expect(inferCorrelationId({ id: "run-1", pid: 42 })).toBe("run-1");
    expect(inferCorrelationId({ runId: "r2" })).toBe("r2");
    expect(inferCorrelationId({ pid: 42 })).toBe("42");
    expect(inferCorrelationId({ foo: "bar" })).toBeUndefined();
    expect(inferCorrelationId("text")).toBeUndefined();
  });

  it("sanitizes payloads: drops functions and cycles, bounds size", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    const result = sanitizePayload({ ctx: { fn: () => 1 }, cyclic, ok: "yes" });
    expect(result.truncated).toBe(true);
    expect(result.payload).toMatchObject({ ctx: {}, cyclic: { a: 1, self: "[circular]" }, ok: "yes" });
    const big = sanitizePayload({ text: "x".repeat(20_000) });
    expect(big.truncated).toBe(true);
    expect(big.payload).toMatchObject({ _truncated: true });
  });

  it("describes a pi-subagents style event", () => {
    const facts = describeExtensionEvent("subagent:async-started", { id: "job-7", pid: 99, mode: "single" });
    expect(facts).toMatchObject({
      channel: "subagent:async-started",
      namespace: "subagent",
      name: "async-started",
      phase: "started",
      correlationId: "job-7",
      payload: { id: "job-7", pid: 99, mode: "single" },
      truncated: false,
    });
    expect(describeExtensionEvent("plain", 1)).toMatchObject({ namespace: "pi", name: "plain", payload: 1 });
  });

  it("taps every emit while still delivering to subscribers; inject bypasses the tap", () => {
    const seen: string[] = [];
    const bus = createTappedEventBus((channel) => seen.push(channel));
    const got: unknown[] = [];
    bus.on("x:started", (data) => got.push(data));
    bus.emit("x:started", 1);
    bus.inject("x:started", 2);
    expect(seen).toEqual(["x:started"]);
    expect(got).toEqual([1, 2]);
  });
});
