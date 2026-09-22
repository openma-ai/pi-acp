import { afterEach, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { createDelegatedTools } from "../src/acp/delegation.ts";
import { Harness } from "./helpers/harness.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

it.each([false, true])("trust loads only the selected project (remember=%s)", async (remember) => {
  h = await Harness.create();
  await h.initialize();
  const install = (cwd: string, name: string) => {
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    const marker = join(h!.root, name);
    writeFileSync(
      join(cwd, ".pi", "extensions", "probe.ts"),
      `import {writeFileSync} from 'node:fs'; export default function(){writeFileSync(${JSON.stringify(marker)},'ran')}`,
    );
    return marker;
  };
  const aMarker = install(h.workspace, "a-ran");
  const b = join(h.root, "other");
  const bMarker = install(b, "b-ran");
  const a = await h.newSession();
  expect(existsSync(aMarker)).toBe(false);
  await h.agent.extMethod("_pi/trust_project", { sessionId: a, remember });
  expect(existsSync(aMarker)).toBe(true);
  await h.client.newSession({ cwd: b, mcpServers: [] });
  expect(existsSync(bMarker)).toBe(false);
});

it("delegated read preserves pi image content", async () => {
  h = await Harness.create();
  writeFileSync(
    join(h.workspace, "pixel.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64",
    ),
  );
  const [read] = createDelegatedTools({
    conn: {} as AgentSideConnection,
    sessionId: "s",
    cwd: h.workspace,
    caps: { readTextFile: true, writeTextFile: false, terminal: false },
  });
  const result = await read!.execute("call", { path: "pixel.png" }, undefined, undefined, {} as never);
  expect(result.content.some((c) => c.type === "image")).toBe(true);
});

it("cancellation during terminal creation terminates the returned terminal", async () => {
  const controller = new AbortController();
  let killed = false;
  const conn = {
    createTerminal: async () => {
      controller.abort();
      return {
        id: "t",
        kill: async () => {
          killed = true;
        },
        waitForExit: async () => ({ exitCode: 0 }),
        currentOutput: async () => ({ output: "" }),
        release: async () => {},
      };
    },
  } as unknown as AgentSideConnection;
  const [bash] = createDelegatedTools({
    conn,
    sessionId: "s",
    cwd: process.cwd(),
    caps: { readTextFile: false, writeTextFile: false, terminal: true },
  });
  await expect(
    bash!.execute("call", { command: "echo hello" }, controller.signal, undefined, {} as never),
  ).rejects.toThrow();
  expect(killed).toBe(true);
});

it("delegated bash executes shell syntax through an executable and argument vector", async () => {
  const { spawn } = await import("node:child_process");
  const conn = {
    createTerminal: async (params: { command: string; args?: string[]; cwd: string }) => {
      const child = spawn(params.command, params.args ?? [], { cwd: params.cwd });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      const exit = new Promise<{ exitCode: number | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (exitCode) => resolve({ exitCode }));
      });
      return {
        id: "shell",
        waitForExit: () => exit,
        currentOutput: async () => ({ output }),
        kill: async () => {
          child.kill();
        },
        release: async () => {
          child.kill();
        },
      };
    },
  } as unknown as AgentSideConnection;
  const [bash] = createDelegatedTools({
    conn,
    sessionId: "s",
    cwd: process.cwd(),
    caps: { readTextFile: false, writeTextFile: false, terminal: true },
  });
  const result = await bash!.execute(
    "call",
    { command: "printf 'hello' && printf ' world'" },
    undefined,
    undefined,
    {} as never,
  );
  expect(result.content).toContainEqual({ type: "text", text: "hello world" });
});
