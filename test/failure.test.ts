import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/acp/errors.ts";
import { diffStats } from "../src/acp/tool-facts.ts";

describe("diffStats", () => {
  it("counts added and removed lines as a multiset", () => {
    expect(diffStats("a\nb\nc\n", "a\nx\nc\n")).toEqual({ added: 1, removed: 1 });
    expect(diffStats(null, "one\ntwo\n")).toEqual({ added: 2, removed: 0 });
    expect(diffStats("same\n", "same\n")).toEqual({ added: 0, removed: 0 });
    expect(diffStats("a\n", "")).toEqual({ added: 0, removed: 1 });
    expect(diffStats("a\nb\n", "b\na\nc\n")).toEqual({ added: 1, removed: 0 });
  });
});

describe("classifyFailure", () => {
  it("maps provider messages onto typed kinds", () => {
    expect(classifyFailure("401 unauthorized: invalid x-api-key")).toBe("auth_required");
    expect(classifyFailure("429 Too Many Requests")).toBe("rate_limited");
    expect(classifyFailure("prompt is too long: context window exceeded")).toBe("context_overflow");
    expect(classifyFailure("fetch failed: ECONNRESET")).toBe("network");
    expect(classifyFailure("502 Bad Gateway")).toBe("provider_error");
    expect(classifyFailure("Request was aborted")).toBe("cancelled");
    expect(classifyFailure("something odd")).toBe("unknown");
  });
});
