#!/usr/bin/env node
/**
 * openma-pi-acp — ACP stdio server for the pi coding agent.
 *
 * stdout is reserved for the protocol; every diagnostic goes to stderr.
 */

import { spawnSync } from "node:child_process";
import { logError } from "./log.ts";
import { serve } from "./server.ts";
import { HELP_TEXT, resolveSettings, SettingsError } from "./settings.ts";
import { PACKAGE_NAME, VERSION } from "./version.ts";

function terminalLogin(): number {
  const command = process.platform === "win32" ? "pi.cmd" : "pi";
  const result = spawnSync(command, [], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    process.stderr.write(
      `${PACKAGE_NAME}: could not start pi (command not found). Install it with ` +
        "`npm install -g @earendil-works/pi-coding-agent` or ensure `pi` is on your PATH.\n",
    );
    return 1;
  }
  return typeof result.status === "number" ? result.status : 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version")) {
    console.log(`${PACKAGE_NAME} ${VERSION}`);
    return;
  }
  if (argv.includes("--help")) {
    console.log(HELP_TEXT.trimEnd());
    return;
  }
  if (argv.includes("--terminal-login")) {
    process.exitCode = terminalLogin();
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

main().catch((error: unknown) => {
  logError(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
