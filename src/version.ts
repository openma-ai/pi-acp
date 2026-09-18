import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readOwnPackage(): { name: string; version: string } {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    try {
      const raw = readFileSync(join(dir, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (typeof parsed.name === "string" && typeof parsed.version === "string") {
        return { name: parsed.name, version: parsed.version };
      }
    } catch {
      // keep walking up
    }
    dir = dirname(dir);
  }
  return { name: "@openma/pi-acp", version: "0.0.0" };
}

const pkg = readOwnPackage();

export const PACKAGE_NAME = pkg.name;
export const VERSION = pkg.version;
export const AGENT_NAME = "openma-pi-acp";
export const AGENT_TITLE = "pi (OpenMA ACP)";
