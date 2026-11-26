import { setTimeout } from "node:timers/promises";
import { expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, Harness } from "./helpers/harness.ts";

it("releases each delegated terminal before starting the next shell call in a turn", async () => {
  const commands: string[] = [];
  const releases: string[] = [];
  const refused: string[] = [];
  let active: string | undefined;
  const harness = await Harness.create({
    clientCapabilities: { terminal: true },
    terminal: {
      createTerminal({ args }) {
        const command = args?.at(-1) ?? "";
        if (active !== undefined) {
          refused.push(command);
          throw new Error("Terminal capacity exceeded");
        }
        commands.push(command);
        active = String(commands.length);
        return { terminalId: active };
      },
      waitForTerminalExit() {
        return { exitCode: 0 };
      },
      terminalOutput() {
        return { output: "ok", truncated: false };
      },
      async releaseTerminal({ terminalId }) {
        await setTimeout(25);
        releases.push(terminalId);
        active = undefined;
      },
    },
  });
  try {
    await harness.initialize();
    const sessionId = await harness.newSession();
    harness.respond(
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "printf first" }),
        fauxToolCall("bash", { command: "printf second" }),
      ]),
      fauxAssistantMessage("done"),
    );
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "Run both commands." }] });

    expect(refused).toEqual([]);
    expect(commands).toEqual(["printf first", "printf second"]);
    expect(releases).toEqual(["1", "2"]);
    const completed = harness
      .updatesFor(sessionId)
      .filter((update) => update.sessionUpdate === "tool_call_update" && update.status === "completed");
    expect(completed).toHaveLength(2);
  } finally {
    await harness.close();
  }
});
