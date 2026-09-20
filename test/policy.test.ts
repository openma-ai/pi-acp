import { describe, expect, it } from "vitest";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { classifyToolRisk, decisionFromOptionId, PermissionPolicy } from "../src/acp/permissions.ts";
import { parseSlashCommand, BUILTIN_COMMANDS } from "../src/acp/commands.ts";
import { resolveSettings, SettingsError } from "../src/settings.ts";
import { sanitizeServerName, mcpToolName } from "../src/acp/mcp.ts";

function call(toolName: string): ToolCallEvent {
  return { type: "tool_call", toolCallId: "t", toolName, input: {} } as ToolCallEvent;
}

describe("PermissionPolicy", () => {
  it("never gates read-only tools", async () => {
    const policy = new PermissionPolicy("read-only");
    expect(
      await policy.gate(call("read"), async () => ({ decision: "reject", remember: false })),
    ).toBeUndefined();
    expect(classifyToolRisk("grep")).toBe("read");
    expect(classifyToolRisk("mcp__x__y")).toBe("mutate");
    expect(classifyToolRisk("get_weather")).toBe("read");
  });

  it("blocks mutations in read-only mode without asking", async () => {
    const policy = new PermissionPolicy("read-only");
    let asked = false;
    const result = await policy.gate(call("bash"), async () => {
      asked = true;
      return { decision: "allow", remember: false };
    });
    expect(asked).toBe(false);
    expect(result).toMatchObject({ block: true });
  });

  it("asks in ask mode and remembers always answers", async () => {
    const policy = new PermissionPolicy("ask");
    let asks = 0;
    const requester = async (): Promise<{ decision: "allow"; remember: boolean }> => {
      asks += 1;
      return { decision: "allow", remember: true };
    };
    expect(await policy.gate(call("edit"), requester)).toBeUndefined();
    expect(await policy.gate(call("edit"), requester)).toBeUndefined();
    expect(asks).toBe(1);
    expect(
      await policy.gate(call("bash"), async () => ({ decision: "reject", remember: true })),
    ).toMatchObject({ block: true });
    expect(
      await policy.gate(call("bash"), async () => ({ decision: "allow", remember: false })),
    ).toMatchObject({ block: true });
  });

  it("terminates the batch when the request was cancelled", async () => {
    const policy = new PermissionPolicy("ask");
    expect(
      await policy.gate(call("write"), async () => ({ decision: "cancelled", remember: false })),
    ).toMatchObject({
      block: true,
      terminate: true,
    });
  });

  it("skips prompts in full-access mode", async () => {
    const policy = new PermissionPolicy("full-access");
    expect(
      await policy.gate(call("bash"), async () => ({ decision: "reject", remember: false })),
    ).toBeUndefined();
  });

  it("maps option ids", () => {
    expect(decisionFromOptionId("allow-always")).toEqual({ decision: "allow", remember: true });
    expect(decisionFromOptionId("reject-once")).toEqual({ decision: "reject", remember: false });
    expect(decisionFromOptionId("weird")).toEqual({ decision: "cancelled", remember: false });
  });
});

describe("slash commands", () => {
  it("parses names and args", () => {
    expect(parseSlashCommand("/model faux/faux-2")).toEqual({ name: "model", args: "faux/faux-2" });
    expect(parseSlashCommand("  /status")).toEqual({ name: "status", args: "" });
    expect(parseSlashCommand("/skill:deploy do it")).toEqual({ name: "skill:deploy", args: "do it" });
    expect(parseSlashCommand("not a command")).toBeUndefined();
    expect(parseSlashCommand("/")).toBeUndefined();
  });

  it("keeps built-in names unique", () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("settings", () => {
  it("applies flags over env and validates modes", () => {
    process.env["PI_ACP_PERMISSION_MODE"] = "read-only";
    try {
      expect(resolveSettings([]).permissionMode).toBe("read-only");
      expect(resolveSettings(["--permission-mode", "full-access"]).permissionMode).toBe("full-access");
      expect(resolveSettings(["--permission-mode=ask", "--no-delegation"]).delegation).toBe(false);
      expect(() => resolveSettings(["--permission-mode", "bogus"])).toThrow(SettingsError);
      expect(() => resolveSettings(["--wat"])).toThrow(SettingsError);
    } finally {
      delete process.env["PI_ACP_PERMISSION_MODE"];
    }
  });
});

describe("mcp names", () => {
  it("sanitizes server names and builds tool names", () => {
    expect(sanitizeServerName("My Server!")).toBe("My_Server_");
    expect(sanitizeServerName("")).toBe("server");
    expect(mcpToolName("gh", "issues")).toBe("mcp__gh__issues");
  });
});
