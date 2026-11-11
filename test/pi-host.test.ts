/**
 * Loading the Pi installation the user chose: version gate, failure modes,
 * and the module identity the adapter shares with that installation.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { piSdk } from "../src/pi/api.ts";
import { loadPiHost, PI_SUPPORTED_RANGE, PiNotFoundError, PiVersionError } from "../src/pi/host.ts";
import { PI_PACKAGE_NAME } from "../src/pi/paths.ts";
import { ensurePiSdk } from "./helpers/pi.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fake Pi installation with a stub entry point. */
function fakePi(version: string): string {
  const root = mkdtempSync(join(tmpdir(), "pi-acp-host-"));
  roots.push(root);
  const dir = join(root, "node_modules", ...PI_PACKAGE_NAME.split("/"));
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: PI_PACKAGE_NAME,
      version,
      type: "module",
      exports: { ".": { import: "./dist/index.js" } },
    }),
  );
  writeFileSync(join(dir, "dist", "index.js"), "export const VERSION = '0.0.0';\n");
  return dir;
}

describe("pi host", () => {
  it("declares the same range as the peer dependency", async () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      peerDependencies?: Record<string, string>;
    };
    expect(manifest.peerDependencies?.[PI_PACKAGE_NAME]).toBe(PI_SUPPORTED_RANGE);
  });

  it("loads the Pi installation and reports its version", async () => {
    await ensurePiSdk();
    const installed = JSON.parse(
      readFileSync(
        join(process.cwd(), "node_modules", ...PI_PACKAGE_NAME.split("/"), "package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(installed.version).toMatch(/^1\./);
  });

  it("shares one module identity with the loaded installation", async () => {
    await ensurePiSdk();
    // The static import and the adapter's dynamic import must be the same
    // module instance, or sessions and the credential store would not share
    // state with the user's Pi.
    expect(piSdk.ModelRuntime).toBe(ModelRuntime);
  });

  it("refuses a Pi version outside the supported range", async () => {
    const dir = fakePi("1.2.0");
    await expect(loadPiHost({ explicit: dir })).rejects.toThrow(PiVersionError);
    await expect(loadPiHost({ explicit: dir })).rejects.toThrow(
      /found Pi 1\.2\.0 .*outside the supported range >=1\.3\.0 <2/,
    );
  });

  it("names the found version and the supported range in the error", async () => {
    const dir = fakePi("2.0.0");
    const error = await loadPiHost({ explicit: dir }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PiVersionError);
    expect((error as PiVersionError).found).toBe("2.0.0");
    expect((error as PiVersionError).range).toBe(PI_SUPPORTED_RANGE);
  });

  it("reports no Pi installation with an actionable message", async () => {
    const empty = mkdtempSync(join(tmpdir(), "pi-acp-host-empty-"));
    roots.push(empty);
    const error = await loadPiHost({ explicit: empty }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PiNotFoundError);
    expect((error as Error).message).toContain(
      "could not find a @earendil-works/pi-coding-agent installation at",
    );
  });

  it("points at the install commands when no Pi is found", async () => {
    const error = await loadPiHost({
      cwd: mkdtempSync(join(tmpdir(), "pi-acp-host-none-")),
      pathEntries: [],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PiNotFoundError);
    const message = (error as Error).message;
    expect(message).toContain("npm install @earendil-works/pi-coding-agent@1.5.2");
    expect(message).toContain("--pi-package-dir");
    expect(message).toContain("PI_ACP_PI_PACKAGE_DIR");
    expect(message).toContain(PI_SUPPORTED_RANGE);
  });
});
