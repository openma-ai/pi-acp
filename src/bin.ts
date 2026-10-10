#!/usr/bin/env node
/**
 * openma-pi-acp — ACP stdio server for the pi coding agent.
 *
 * stdout is reserved for the protocol; every diagnostic goes to stderr.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logError } from "./log.ts";
import { serve } from "./server.ts";
import { HELP_TEXT, resolveSettings, SettingsError } from "./settings.ts";
import { terminalLogin } from "./terminal-login.ts";
import { PACKAGE_NAME, VERSION } from "./version.ts";

export async function main(argv: string[]): Promise<void> {
  if (argv.includes("--version")) {
    console.log(`${PACKAGE_NAME} ${VERSION}`);
    return;
  }
  if (argv.includes("--help")) {
    console.log(HELP_TEXT.trimEnd());
    return;
  }
  if (argv.includes("--terminal-login")) {
    process.exitCode = await terminalLogin(argv);
    return;
  }

  let settings;
  try {
    settings = resolveSettings(argv);
  } catch (error: unknown) {
    if (error instanceof SettingsError) {
      logError(error.message);
      process.stderr.write(`\n${HELP_TEXT}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  const server = serve({ settings });

  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void server.agent
      .dispose()
      .catch((error: unknown) => logError(`teardown failed: ${String(error)}`))
      .finally(() => process.exit(code));
  };
  process.stdin.on("end", () => shutdown(0));
  process.stdin.on("close", () => shutdown(0));
  process.stdout.on("error", () => shutdown(0));
  process.on("SIGINT", () => shutdown(130));
  process.on("SIGTERM", () => shutdown(143));
  await server.closed;
  shutdown(0);
}

/* v8 ignore start -- entry-point bootstrap: only true when run as the binary (the
 * subprocess e2e test covers it); skipped on import so tests can call main() safely */
try {
  const entry = process.argv[1];
  if (entry !== undefined && realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url))) {
    main(process.argv.slice(2)).catch((error: unknown) => {
      logError(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(1);
    });
  }
} catch {
  // entry-point detection failed (missing argv[1] or unreadable path): not the binary
}
/* v8 ignore stop */
