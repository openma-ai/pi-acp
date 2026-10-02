/**
 * Pure checks for the additionalDirectories path boundary.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  additionalDirectoriesCapability,
  additionalDirectoriesSupported,
  AdditionalDirectoriesError,
  MAX_ADDITIONAL_DIRECTORIES,
  persistedAdditionalDirectories,
  resolveAdditionalDirectoriesRequest,
  shellAccessPaths,
  validateAdditionalDirectories,
  WorkspaceScope,
} from "../src/acp/workspace-scope.ts";

const root = mkdtempSync(join(tmpdir(), "pi-acp-scope-unit-"));
const cwd = join(root, "work");
const extra = join(root, "extra");
mkdirSync(cwd, { recursive: true });
mkdirSync(extra, { recursive: true });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("additionalDirectories policy", () => {
  it("probes a working boundary before advertising the capability", () => {
    expect(additionalDirectoriesSupported()).toBe(true);
    expect(additionalDirectoriesCapability()).toEqual({});
  });

  it("warns and ignores the field when the scope check is unavailable", () => {
    expect(
      resolveAdditionalDirectoriesRequest(["/tmp"], cwd, { supported: false, restoreWhenOmitted: false }),
    ).toEqual({
      kind: "ignored",
      directories: [],
      warning: expect.stringContaining("workspace scope is unavailable"),
    });
  });

  it("rejects roots, home, relative paths, missing paths, and files", () => {
    const file = join(root, "file.txt");
    writeFileSync(file, "x");
    expect(() => validateAdditionalDirectories(["relative"], cwd)).toThrow(AdditionalDirectoriesError);
    expect(() => validateAdditionalDirectories(["relative"], cwd)).toThrow(/absolute path/);
    expect(() => validateAdditionalDirectories(["/"], cwd)).toThrow(/filesystem root/);
    expect(() => validateAdditionalDirectories([homedir()], cwd)).toThrow(/home directory/);
    expect(() => validateAdditionalDirectories([join(root, "missing")], cwd)).toThrow(
      /not an existing directory/,
    );
    expect(() => validateAdditionalDirectories([file], cwd)).toThrow(/not an existing directory/);
  });

  it("canonicalizes, drops cwd duplicates, and caps the list", () => {
    expect(validateAdditionalDirectories([extra, cwd, extra], cwd)).toEqual([realpathSync(extra)]);
    const dirs = Array.from({ length: MAX_ADDITIONAL_DIRECTORIES + 1 }, (_, index) => {
      const dir = join(root, `cap-${index}`);
      mkdirSync(dir, { recursive: true });
      return dir;
    });
    expect(() => validateAdditionalDirectories(dirs, cwd)).toThrow(/at most 16/);
  });

  it("restores on omit for load and treats omit as empty for new", () => {
    expect(
      resolveAdditionalDirectoriesRequest(undefined, cwd, { supported: true, restoreWhenOmitted: true }).kind,
    ).toBe("restore");
    expect(
      resolveAdditionalDirectoriesRequest(undefined, cwd, { supported: true, restoreWhenOmitted: false }),
    ).toEqual({ kind: "explicit", directories: [] });
    expect(
      resolveAdditionalDirectoriesRequest([], cwd, { supported: true, restoreWhenOmitted: true }),
    ).toEqual({
      kind: "explicit",
      directories: [],
    });
  });

  it("keeps the newest persisted list on the active branch", () => {
    const entries = [
      { type: "session", id: "header" },
      {
        type: "custom",
        id: "a",
        parentId: null,
        customType: "pi-acp:additional-directories",
        data: { directories: ["/old"] },
      },
      { type: "message", id: "b", parentId: "a" },
      {
        type: "custom",
        id: "abandoned",
        parentId: "a",
        customType: "pi-acp:additional-directories",
        data: { directories: ["/nope"] },
      },
      {
        type: "custom",
        id: "c",
        parentId: "b",
        customType: "pi-acp:additional-directories",
        data: { directories: ["/new"] },
      },
    ];
    expect(persistedAdditionalDirectories(entries)).toEqual(["/new"]);
  });

  it("rejects symlink escapes and allows paths inside cwd or an extra root", () => {
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    symlinkSync(outside, join(cwd, "escape"));
    symlinkSync(join(outside, "secret.txt"), join(cwd, "leak.txt"));
    symlinkSync(join(outside, "missing"), join(cwd, "broken"));
    const scope = new WorkspaceScope(cwd);
    scope.setAdditional([realpathSync(extra)]);
    expect(scope.denial("note.txt")).toBeUndefined();
    expect(scope.denial(join(extra, "a.txt"))).toBeUndefined();
    expect(scope.denial(join(outside, "secret.txt"))).toMatch(/outside the session workspace/);
    expect(scope.denial(join(cwd, "leak.txt"))).toMatch(/outside the session workspace/);
    expect(scope.denial(join(cwd, "escape", "pwn.txt"))).toMatch(/outside the session workspace/);
    expect(scope.denial("broken")).toMatch(/cannot be resolved safely/);
    expect(scope.shellDenial("echo hello")).toBeUndefined();
    expect(scope.shellDenial("sleep 5; echo late")).toBeUndefined();
    expect(scope.shellDenial("printf shell > shell.txt")).toBeUndefined();
    expect(scope.shellDenial("echo done 2>/dev/null")).toBeUndefined();
    expect(scope.shellDenial('echo "fix /tmp bug"')).toMatch(/outside the session workspace/);
    expect(scope.shellDenial(`cat ${join(extra, "a.txt")}`)).toBeUndefined();
    expect(scope.shellDenial(`cat ${join(outside, "secret.txt")}`)).toMatch(/outside the session workspace/);
    expect(scope.shellDenial("cat ../outside/secret.txt")).toMatch(/outside the session workspace/);
    expect(scope.shellDenial("cat $HOME/secret")).toMatch(/cannot verify/);
    expect(scope.shellDenial(`python -c 'open("${join(outside, "secret.txt")}")'`)).toMatch(
      /outside the session workspace/,
    );
    expect(shellAccessPaths("printf shell > shell.txt").paths).toEqual(["shell.txt"]);
  });
});
