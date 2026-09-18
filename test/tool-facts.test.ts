import { describe, expect, it } from "vitest";
import {
  classifyToolCall,
  editOldTexts,
  fenceShellOutput,
  findUniqueLineNumber,
  parseMcpToolName,
  toolResultText,
} from "../src/acp/tool-facts.ts";

describe("classifyToolCall", () => {
  it("maps bash to execute with the first command line as title", () => {
    const facts = classifyToolCall("bash", { command: "npm test\necho done" }, "/w");
    expect(facts.kind).toBe("execute");
    expect(facts.title).toBe("npm test");
    expect(facts.locations).toEqual([]);
  });

  it("maps file tools with absolute locations resolved against cwd", () => {
    expect(classifyToolCall("read", { path: "src/a.ts" }, "/w")).toMatchObject({
      kind: "read",
      title: "Read src/a.ts",
      locations: [{ path: "/w/src/a.ts" }],
    });
    expect(classifyToolCall("write", { path: "/abs/b.ts" }, "/w").kind).toBe("edit");
    expect(classifyToolCall("edit", { path: "c.ts" }, "/w", 12).locations).toEqual([
      { path: "/w/c.ts", line: 12 },
    ]);
  });

  it("maps search tools and the plan tool", () => {
    expect(classifyToolCall("grep", { pattern: "foo" }, "/w")).toMatchObject({
      kind: "search",
      title: "Search for 'foo'",
    });
    expect(classifyToolCall("find", { pattern: "*.ts" }, "/w").kind).toBe("search");
    expect(classifyToolCall("ls", { path: "." }, "/w").kind).toBe("search");
    expect(classifyToolCall("update_plan", {}, "/w")).toMatchObject({ kind: "think", title: "Update plan" });
  });

  it("labels MCP tools by server and uses name heuristics", () => {
    expect(classifyToolCall("mcp__github__search_issues", { query: "bug" }, "/w")).toMatchObject({
      kind: "search",
      title: "github: search_issues 'bug'",
    });
    expect(classifyToolCall("mcp__web__fetch_url", { url: "https://x" }, "/w").kind).toBe("fetch");
    expect(classifyToolCall("mystery", {}, "/w")).toMatchObject({ kind: "other", title: "mystery" });
    expect(parseMcpToolName("mcp__a__b__c")).toEqual({ server: "a", tool: "b__c" });
    expect(parseMcpToolName("bash")).toBeUndefined();
  });
});

describe("result helpers", () => {
  it("joins text blocks of a pi tool result", () => {
    expect(
      toolResultText({
        content: [
          { type: "text", text: "a" },
          { type: "image", data: "x" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("ab");
    expect(toolResultText(undefined)).toBe("");
  });

  it("finds a unique line and rejects ambiguous needles", () => {
    expect(findUniqueLineNumber("a\nb\nc\n", "c")).toBe(3);
    expect(findUniqueLineNumber("a\na\n", "a")).toBeUndefined();
    expect(findUniqueLineNumber("a", "z")).toBeUndefined();
  });

  it("extracts edit needles from structured and stringified edits", () => {
    expect(editOldTexts({ edits: [{ oldText: "x", newText: "y" }] })).toEqual(["x"]);
    expect(
      editOldTexts({ edits: JSON.stringify([{ oldText: "q", newText: "r" }]), oldText: "legacy" }),
    ).toEqual(["legacy", "q"]);
  });

  it("fences shell output and drops trailing newlines", () => {
    expect(fenceShellOutput("hi\n\n")).toBe("```sh\nhi\n```\n");
    expect(fenceShellOutput("")).toBe("");
  });
});
