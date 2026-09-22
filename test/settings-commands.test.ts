import { describe, expect, it } from "vitest";
import { parseSlashCommand, BUILTIN_COMMANDS } from "../src/acp/commands.ts";
import { resolveSettings, SettingsError } from "../src/settings.ts";

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
  it("applies model flags over environment and rejects removed permission flags", () => {
    const previous = process.env["PI_ACP_MODEL"];
    process.env["PI_ACP_MODEL"] = "faux/faux-1";
    try {
      expect(resolveSettings([]).model).toBe("faux/faux-1");
      expect(resolveSettings(["--model", "faux/faux-2"]).model).toBe("faux/faux-2");
      expect(resolveSettings(["--no-delegation"]).delegation).toBe(false);
      expect(() => resolveSettings(["--permission-mode", "ask"])).toThrow(SettingsError);
      expect(() => resolveSettings(["--wat"])).toThrow(SettingsError);
    } finally {
      if (previous === undefined) delete process.env["PI_ACP_MODEL"];
      else process.env["PI_ACP_MODEL"] = previous;
    }
  });
});
