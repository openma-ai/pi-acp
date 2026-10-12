/**
 * `openma-pi-acp --terminal-login`: the focused login flow behind the
 * `pi-terminal-login` ACP auth method. Runs pi's own provider auth (API-key
 * prompts, OAuth browser/device flows) in-process through a readline
 * AuthInteraction — no separate `pi` binary required — against the same
 * credential store the ACP server uses.
 */

import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { createInterface, type Interface } from "node:readline";
import { errorMessage } from "./log.ts";
import { HELP_TEXT, resolveSettings, SettingsError } from "./settings.ts";
import { PACKAGE_NAME } from "./version.ts";

interface LoginChoice {
  provider: string;
  type: "api_key" | "oauth";
  label: string;
}

function loginChoices(modelRuntime: ModelRuntime): LoginChoice[] {
  const choices: LoginChoice[] = [];
  for (const provider of modelRuntime.getProviders()) {
    const { apiKey, oauth } = provider.auth;
    if (apiKey?.login !== undefined) {
      choices.push({ provider: provider.id, type: "api_key", label: `${apiKey.name} (API key)` });
    }
    if (oauth !== undefined) {
      choices.push({
        provider: provider.id,
        type: "oauth",
        label: oauth.loginLabel ?? `${oauth.name} (browser sign-in)`,
      });
    }
  }
  return choices;
}

function writeLine(output: NodeJS.WritableStream, text: string): void {
  output.write(`${text}\n`);
}

const CANCELLED = "stdin closed";

/** Question helpers that reject on EOF so callers can report a cancelled login. */
function createAsker(
  rl: Interface,
  output: NodeJS.WritableStream,
): {
  ask: (question: string) => Promise<string>;
  askSecret: (question: string) => Promise<string>;
} {
  let closed = false;
  let pending: (() => void) | undefined;
  rl.once("close", () => {
    closed = true;
    pending?.();
  });
  const ask = (question: string): Promise<string> => {
    if (closed) return Promise.reject(new Error(CANCELLED));
    return new Promise((resolve, reject) => {
      pending = () => {
        pending = undefined;
        reject(new Error(CANCELLED));
      };
      rl.question(question, (answer) => {
        pending = undefined;
        resolve(answer);
      });
    });
  };
  const askSecret = (question: string): Promise<string> => {
    const tty = (output as { isTTY?: boolean }).isTTY === true;
    const muted = rl as unknown as { _writeToOutput: (chunk: string) => void };
    if (!tty) return ask(question);
    const original = muted._writeToOutput.bind(rl);
    muted._writeToOutput = (chunk: string) => {
      // The prompt was written already; every typed character echoes as *.
      original(chunk.replace(/[^\r\n]/g, "*"));
    };
    writeLine(output, question);
    return ask("").finally(() => {
      muted._writeToOutput = original;
    });
  };
  return { ask, askSecret };
}

/** Readline-backed pi AuthInteraction for `--terminal-login`. */
function terminalInteraction(
  ask: (question: string) => Promise<string>,
  askSecret: (question: string) => Promise<string>,
  output: NodeJS.WritableStream,
): AuthInteraction {
  return {
    notify(event) {
      switch (event.type) {
        case "info": {
          writeLine(output, event.message);
          for (const link of event.links ?? []) {
            writeLine(output, `  ${link.label ?? "Link"}: ${link.url}`);
          }
          break;
        }
        case "auth_url": {
          writeLine(output, event.instructions ?? "Open this URL to sign in:");
          writeLine(output, `  ${event.url}`);
          break;
        }
        case "device_code": {
          writeLine(output, `Go to ${event.verificationUri} and enter the code: ${event.userCode}`);
          break;
        }
        case "progress": {
          writeLine(output, event.message);
          break;
        }
      }
    },
    async prompt(prompt) {
      switch (prompt.type) {
        case "secret":
          return askSecret(prompt.message);
        case "select": {
          writeLine(output, prompt.message);
          prompt.options.forEach((option, index) => {
            const detail = option.description !== undefined ? ` — ${option.description}` : "";
            writeLine(output, `  ${index + 1}) ${option.label}${detail}`);
          });
          for (;;) {
            const answer = (await ask(`Choice [1-${prompt.options.length}]: `)).trim();
            const option = prompt.options[Number.parseInt(answer, 10) - 1];
            if (option !== undefined) return option.id;
            writeLine(output, "Enter a number from the list.");
          }
        }
        case "text":
        case "manual_code":
          return ask(`${prompt.message}: `);
      }
    },
  };
}

export interface TerminalLoginOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  modelRuntime: ModelRuntime;
}

/**
 * The interactive login itself, split out for tests: piped stdio drives the
 * same readline flow a real terminal would.
 */
export async function runTerminalLogin(options: TerminalLoginOptions): Promise<number> {
  const { input, output, modelRuntime } = options;
  const signedIn = (await modelRuntime.listCredentials()).map((c) => c.providerId);
  if (signedIn.length > 0) {
    writeLine(output, `Signed in: ${signedIn.join(", ")}`);
  }
  const choices = loginChoices(modelRuntime);
  if (choices.length === 0) {
    writeLine(output, "No providers support interactive login.");
    return 1;
  }
  writeLine(output, "Login methods:");
  choices.forEach((choice, index) => writeLine(output, `  ${index + 1}) ${choice.label}`));
  const rl = createInterface({
    input,
    output,
    terminal: (output as { isTTY?: boolean }).isTTY === true,
  });
  const { ask, askSecret } = createAsker(rl, output);
  try {
    let choice: LoginChoice | undefined;
    try {
      const answer = (await ask(`\nLogin method [1-${choices.length}]: `)).trim();
      choice = choices[Number.parseInt(answer, 10) - 1];
    } catch {
      writeLine(output, "Login cancelled.");
      return 1;
    }
    if (choice === undefined) {
      writeLine(output, "Enter a number from the list.");
      return 1;
    }
    try {
      await modelRuntime.login(choice.provider, choice.type, terminalInteraction(ask, askSecret, output));
    } catch (error: unknown) {
      writeLine(output, `Login failed: ${errorMessage(error)}`);
      return 1;
    }
    writeLine(output, `Signed in to ${choice.provider} (${choice.type}). You can close this window.`);
    return 0;
  } finally {
    rl.close();
  }
}

/** `--terminal-login` entry point: build the runtime for pi's own agent dir. */
export async function terminalLogin(argv: string[]): Promise<number> {
  let settings;
  try {
    settings = resolveSettings(argv);
  } catch (error: unknown) {
    if (error instanceof SettingsError) {
      process.stderr.write(`${error.message}\n\n${HELP_TEXT}`);
      return 2;
    }
    throw error;
  }
  const agentDir = settings.agentDir ?? getAgentDir();
  let modelRuntime: ModelRuntime;
  try {
    modelRuntime = await ModelRuntime.create({
      authPath: `${agentDir}/auth.json`,
      modelsPath: `${agentDir}/models.json`,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error: unknown) {
    process.stderr.write(
      `${PACKAGE_NAME}: could not initialize pi auth at ${agentDir} (${errorMessage(error)})\n`,
    );
    return 1;
  }
  return runTerminalLogin({ input: process.stdin, output: process.stdout, modelRuntime });
}
