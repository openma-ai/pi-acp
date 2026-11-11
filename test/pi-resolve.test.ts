/**
 * Where the user's Pi installation is found.
 *
 * The fixtures build real directory trees (package.json files, `node_modules`
 * layouts, `pi` executables) so the precedence rules are exercised against the
 * filesystem instead of mocks.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalPath,
  isInside,
  isWindowsPath,
  normalizePath,
  packageDirFromText,
  piPackageDirFromLocation,
  projectDeclaresPi,
  projectRootOf,
  resolvePiPackage,
  samePath,
  splitPath,
  type ResolveContext,
} from "../src/pi/resolve.ts";

const PI = "@earendil-works/pi-coding-agent";
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-acp-resolve-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Write a fake Pi installation and return its package directory. */
function writePi(root: string, version = "1.5.2"): string {
  const dir = join(root, "node_modules", ...PI.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: PI, version, type: "module", main: "./dist/index.js" }),
  );
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.js"), "export const VERSION = 'x';\n");
  return dir;
}

/** Write a fake package (not Pi) and return its directory. */
function writePackage(root: string, name: string, version = "1.0.0"): string {
  const dir = join(root, "node_modules", ...name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
  return dir;
}

/** Write a package.json manifest at `dir`. */
function writeManifest(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
}

/**
 * Compare a resolved package directory against the directory the fixture
 * built. The resolver follows symlinks — macOS maps `/var` to `/private/var`
 * — so both sides are compared in canonical form.
 */
function expectSameDirectory(actual: string | undefined, expected: string): void {
  expect(actual).toBeDefined();
  expect(canonicalPath(actual ?? "")).toBe(canonicalPath(expected));
}

function context(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return { cwd: tempRoot(), pathEntries: [], ...overrides };
}

describe("pi package location", () => {
  it("finds the package in a project install", () => {
    const project = tempRoot();
    const packageDir = writePi(project);
    const result = resolvePiPackage(context({ cwd: project }));
    expectSameDirectory(result.selected?.packageDir, packageDir);
    expect(result.selected?.source).toBe("project");
  });

  it("prefers an explicit location over every other candidate", () => {
    const explicitRoot = tempRoot();
    const explicit = writePi(explicitRoot);
    const project = tempRoot();
    writePi(project);
    const result = resolvePiPackage(context({ cwd: project, explicit: explicitRoot }));
    expect(result.selected?.source).toBe("explicit");
    expectSameDirectory(result.selected?.packageDir, explicit);
  });

  it("accepts the package directory itself as an explicit location", () => {
    const root = tempRoot();
    const packageDir = writePi(root);
    const result = resolvePiPackage(context({ explicit: packageDir }));
    expectSameDirectory(result.selected?.packageDir, packageDir);
  });

  it("accepts a node_modules root as an explicit location", () => {
    const root = tempRoot();
    const packageDir = writePi(root);
    const result = resolvePiPackage(context({ explicit: join(root, "node_modules") }));
    expectSameDirectory(result.selected?.packageDir, packageDir);
  });

  it("accepts a project directory as an explicit location", () => {
    const root = tempRoot();
    const packageDir = writePi(root);
    const result = resolvePiPackage(context({ explicit: root }));
    expectSameDirectory(result.selected?.packageDir, packageDir);
  });

  it("fails when an explicit location holds no Pi installation", () => {
    const empty = tempRoot();
    expect(() => resolvePiPackage(context({ explicit: empty }))).toThrow(/no @earendil-works/);
  });

  it("uses the package behind the pi executable on PATH", () => {
    const prefix = tempRoot();
    const packageDir = writePi(prefix);
    const binDir = join(prefix, "bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(join(packageDir, "dist", "index.js"), join(binDir, "pi"));
    const result = resolvePiPackage(context({ pathEntries: [binDir] }));
    expect(result.selected?.source).toBe("path");
    expectSameDirectory(result.selected?.packageDir, packageDir);
  });

  it("keeps scanning PATH past a pi executable that belongs to another package", () => {
    const prefix = tempRoot();
    const packageDir = writePi(prefix);
    const other = writePackage(prefix, "other-pi");
    const otherBin = join(prefix, "other-bin");
    mkdirSync(otherBin, { recursive: true });
    writeFileSync(join(other, "index.js"), "");
    symlinkSync(join(other, "index.js"), join(otherBin, "pi"));
    const binDir = join(prefix, "bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(join(packageDir, "dist", "index.js"), join(binDir, "pi"));
    const result = resolvePiPackage(context({ pathEntries: [otherBin, binDir] }));
    expectSameDirectory(result.selected?.packageDir, packageDir);
    expect(result.selected?.detail).toBe(join(binDir, "pi"));
  });

  it("resolves the package behind a pi executable through a symlinked directory", () => {
    // macOS points the temporary directory at /private/var, so the resolver
    // sees a different prefix than the one the fixture was written under.
    const real = tempRoot();
    const alias = join(real, "alias");
    symlinkSync(real, alias, "junction");
    const packageDir = writePi(alias);
    const binDir = join(alias, "bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(join(packageDir, "dist", "index.js"), join(binDir, "pi"));
    const result = resolvePiPackage(context({ pathEntries: [binDir] }));
    expect(result.selected?.source).toBe("path");
    expectSameDirectory(result.selected?.packageDir, packageDir);
  });

  it("falls back to the global root next to this package", () => {
    const globalRoot = tempRoot();
    const packageDir = writePi(globalRoot);
    const adapterDir = join(globalRoot, "node_modules", "@openma", "pi-acp");
    mkdirSync(adapterDir, { recursive: true });
    const result = resolvePiPackage(
      context({ adapterPackageDir: adapterDir, adapterNodeModulesRoot: join(globalRoot, "node_modules") }),
    );
    expect(result.selected?.source).toBe("global");
    expectSameDirectory(result.selected?.packageDir, packageDir);
  });

  it("rejects the copy npm auto-installed as this package's peer dependency", () => {
    const project = tempRoot();
    const peer = writePi(project);
    writeManifest(project, { name: "app", dependencies: { "@openma/pi-acp": "^0.1.9" } });
    const result = resolvePiPackage(
      context({
        cwd: project,
        adapterPeerPackageDir: peer,
        adapterPackageDir: join(project, "node_modules", "@openma", "pi-acp"),
      }),
    );
    expect(result.selected).toBeUndefined();
    expectSameDirectory(result.rejections[0]?.packageDir, peer);
    expect(result.rejections[0]?.reason).toMatch(/peer dependency/);
  });

  it("accepts the peer copy when the project declares Pi itself", () => {
    const project = tempRoot();
    const peer = writePi(project);
    writeManifest(project, {
      name: "app",
      dependencies: { "@openma/pi-acp": "^0.1.9" },
      devDependencies: { [PI]: "^1.5.0" },
    });
    const result = resolvePiPackage(context({ cwd: project, adapterPeerPackageDir: peer }));
    expectSameDirectory(result.selected?.packageDir, peer);
    expect(result.selected?.source).toBe("project");
  });

  it("prefers a project install over the pi executable on PATH", () => {
    const project = tempRoot();
    const projectPi = writePi(project);
    const prefix = tempRoot();
    const globalPi = writePi(prefix);
    const binDir = join(prefix, "bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(join(globalPi, "dist", "index.js"), join(binDir, "pi"));
    const result = resolvePiPackage(context({ cwd: project, pathEntries: [binDir] }));
    expectSameDirectory(result.selected?.packageDir, projectPi);
  });

  it("reports nothing found when no candidate exists", () => {
    const result = resolvePiPackage(context());
    expect(result.selected).toBeUndefined();
    expect(result.rejections).toEqual([]);
  });
});

describe("pi package detection", () => {
  it("reads the project that owns a node_modules copy", () => {
    const project = tempRoot();
    const packageDir = writePi(project);
    expect(projectRootOf(packageDir)).toBe(project);
    expect(projectDeclaresPi(packageDir)).toBe(false);
    writeManifest(project, { name: "app", dependencies: { [PI]: "^1.5.0" } });
    expect(projectDeclaresPi(packageDir)).toBe(true);
  });

  it("finds no package in an empty location", () => {
    expect(piPackageDirFromLocation(tempRoot())).toBeUndefined();
  });

  it("keeps Windows paths intact", () => {
    expect(isWindowsPath("C:\\Users\\me\\pi")).toBe(true);
    expect(isWindowsPath("\\\\server\\share\\pi")).toBe(true);
    expect(isWindowsPath("/home/me/pi")).toBe(false);
    expect(normalizePath("C:/Users//me/pi")).toBe("C:\\Users\\me\\pi");
    expect(samePath("C:\\Users\\me\\", "C:\\Users\\me")).toBe(true);
    expect(isInside("C:\\Users\\me", "C:\\Users\\me\\pi\\x")).toBe(true);
    expect(isInside("/home/me", "/home/other/pi")).toBe(false);
  });

  it("splits paths with either separator", () => {
    expect(splitPath("C:\\a\\b")).toEqual({ parts: ["C:", "a", "b"], separator: "\\" });
    expect(splitPath("/a/b")).toEqual({ parts: ["a", "b"], separator: "/" });
  });

  it("reads the Pi path out of a Windows cmd shim", () => {
    const shim = [
      "@ECHO off",
      "SETLOCAL",
      'IF EXIST "%~dp0\\node.exe" (',
      '  "%~dp0\\node.exe"  "%~dp0\\..\\lib\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*',
      ")",
    ].join("\r\n");
    const found = packageDirFromText(shim, "C:\\Users\\me\\AppData\\Roaming\\npm");
    expect(found).toBe(
      "C:\\Users\\me\\AppData\\Roaming\\npm\\..\\lib\\node_modules\\@earendil-works\\pi-coding-agent",
    );
  });

  it("finds no Pi path in unrelated text", () => {
    expect(packageDirFromText("nothing to see here")).toBeUndefined();
  });
});
