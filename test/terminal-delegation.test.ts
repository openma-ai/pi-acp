/**
 * Delegated ACP terminals: one live terminal per session.
 *
 * ACP clients may cap live terminals per session (one at a time is common).
 * The delegated `bash` tool therefore has to take the terminal one call at a
 * time and hand it back before the next call asks for one.
 */

import type { Client } from "@agentclientprotocol/sdk";
import { setTimeout } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, Harness } from "./helpers/harness.ts";

type TerminalClient = Pick<
  Client,
  "createTerminal" | "terminalOutput" | "waitForTerminalExit" | "releaseTerminal" | "killTerminal"
>;

interface TerminalLog {
  /** Commands that got a terminal, in creation order. */
  created: string[];
  /** Commands refused because a terminal was still live. */
  refused: string[];
  /** Terminal ids in release order. */
  released: string[];
  /** Terminal ids that were killed (timeout or abort). */
  killed: string[];
}

interface FakeTerminalOptions {
  /** How long `terminal/release` takes; a non-awaited release races the next call. */
  releaseDelayMs?: number;
  /** Exit code per command. Defaults to 0. */
  exitCode?: (command: string) => number;
  /** Commands that never exit until the terminal is killed. */
  blocks?: (command: string) => boolean;
}

/**
 * A client that allows exactly one live terminal and refuses `terminal/create`
 * while another one is live.
 */
function singleTerminalClient(options: FakeTerminalOptions = {}): {
  client: TerminalClient;
  log: TerminalLog;
} {
  const log: TerminalLog = { created: [], refused: [], released: [], killed: [] };
  const commands = new Map<string, string>();
  const blockers = new Map<string, () => void>();
  const killed = new Set<string>();
  let active: string | undefined;
  let nextId = 0;

  const client: TerminalClient = {
    createTerminal({ args }) {
      const command = args?.at(-1) ?? "";
      if (active !== undefined) {
        log.refused.push(command);
        throw new Error("client allows only one live terminal");
      }
      nextId += 1;
      const terminalId = String(nextId);
      log.created.push(command);
      commands.set(terminalId, command);
      active = terminalId;
      return { terminalId };
    },
    terminalOutput() {
      return { output: "ok", truncated: false };
    },
    async waitForTerminalExit({ terminalId }) {
      const command = commands.get(terminalId) ?? "";
      if (options.blocks?.(command) === true) {
        await new Promise<void>((resolve) => blockers.set(terminalId, resolve));
        return killed.has(terminalId) ? { exitCode: null, signal: "SIGTERM" } : { exitCode: 0, signal: null };
      }
      return { exitCode: options.exitCode?.(command) ?? 0, signal: null };
    },
    async killTerminal({ terminalId }) {
      log.killed.push(terminalId);
      killed.add(terminalId);
      blockers.get(terminalId)?.();
    },
    async releaseTerminal({ terminalId }) {
      await setTimeout(options.releaseDelayMs ?? 25);
      log.released.push(terminalId);
      if (active === terminalId) active = undefined;
    },
  };

  return { client, log };
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** Poll until `predicate` holds; the harness has no clock we can await directly. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await setTimeout(5);
  }
}

function toolUpdates(sessionId: string, status: "completed" | "failed") {
  return harness!
    .updatesFor(sessionId)
    .filter((update) => update.sessionUpdate === "tool_call_update" && update.status === status);
}

describe("delegated terminals", () => {
  it("runs sibling shell calls one at a time and releases each terminal", async () => {
    const fake = singleTerminalClient();
    harness = await Harness.create({ clientCapabilities: { terminal: true }, terminal: fake.client });
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "printf first" }),
        fauxToolCall("bash", { command: "printf second" }),
      ]),
      fauxAssistantMessage("done"),
    );

    await harness.client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Run both commands." }],
    });

    // The client never refused a terminal.
    expect(fake.log.refused).toEqual([]);
    // Both commands ran, in the order the model asked for them.
    expect(fake.log.created).toEqual(["printf first", "printf second"]);
    // Both terminals were handed back.
    expect(fake.log.released).toEqual(["1", "2"]);
    // Both tool calls completed.
    expect(toolUpdates(sessionId, "completed")).toHaveLength(2);
    expect(toolUpdates(sessionId, "failed")).toHaveLength(0);
  });

  it("releases the terminal when a command fails, so the next one still runs", async () => {
    const fake = singleTerminalClient({
      exitCode: (command) => (command === "boom" ? 1 : 0),
    });
    harness = await Harness.create({ clientCapabilities: { terminal: true }, terminal: fake.client });
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "boom" }),
        fauxToolCall("bash", { command: "printf second" }),
      ]),
      fauxAssistantMessage("done"),
    );

    await harness.client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Run both commands." }],
    });

    expect(fake.log.refused).toEqual([]);
    expect(fake.log.created).toEqual(["boom", "printf second"]);
    expect(fake.log.released).toEqual(["1", "2"]);
    expect(toolUpdates(sessionId, "failed")).toHaveLength(1);
    expect(toolUpdates(sessionId, "completed")).toHaveLength(1);
  });

  it("releases the terminal when a command times out", async () => {
    const fake = singleTerminalClient({ blocks: (command) => command === "sleep forever" });
    harness = await Harness.create({ clientCapabilities: { terminal: true }, terminal: fake.client });
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "sleep forever", timeout: 0.05 }),
        fauxToolCall("bash", { command: "printf second" }),
      ]),
      fauxAssistantMessage("done"),
    );

    await harness.client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Run both commands." }],
    });

    expect(fake.log.refused).toEqual([]);
    expect(fake.log.killed).toEqual(["1"]);
    expect(fake.log.created).toEqual(["sleep forever", "printf second"]);
    expect(fake.log.released).toEqual(["1", "2"]);
    expect(toolUpdates(sessionId, "failed")).toHaveLength(1);
    expect(toolUpdates(sessionId, "completed")).toHaveLength(1);
  });

  it("releases the terminal when the turn is cancelled", async () => {
    const fake = singleTerminalClient({ blocks: () => true });
    harness = await Harness.create({ clientCapabilities: { terminal: true }, terminal: fake.client });
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep forever" })]),
      fauxAssistantMessage("done"),
    );

    const prompt = harness.client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Run a command." }],
    });
    await waitFor(() => fake.log.created.length === 1);
    await harness.client.cancel({ sessionId });
    const response = await prompt;

    expect(response.stopReason).toBe("cancelled");
    expect(fake.log.refused).toEqual([]);
    expect(fake.log.killed).toEqual(["1"]);
    expect(fake.log.released).toEqual(["1"]);
  });
});
