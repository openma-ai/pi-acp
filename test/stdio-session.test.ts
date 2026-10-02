/**
 * Model switch and mid-turn steer over the real stdio ACP wire.
 * The child is `serve()` (the same entry as the bin) on pi's runtime.
 * Only the model provider is faux.
 */

import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type RequestPermissionResponse,
  type Stream,
} from "@agentclientprotocol/sdk";
import { afterEach, expect, it } from "vitest";

let child: ChildProcessWithoutNullStreams | undefined;
let root: string | undefined;

afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function childStream(proc: ChildProcessWithoutNullStreams): Stream {
  const input = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        proc.stdin.write(Buffer.from(chunk), (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  });
  return ndJsonStream(output, input);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 20_000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it("persists a model switch over stdio and steers at the next model call", async () => {
  root = mkdtempSync(join(tmpdir(), "pi-acp-stdio-"));
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const workspace = join(root, "work");
  mkdirSync(agentDir);
  mkdirSync(sessionDir);
  mkdirSync(workspace);
  const settings = join(agentDir, "settings.json");
  writeFileSync(settings, JSON.stringify({ quietStartup: true, retry: { enabled: false } }));
  const callLog = join(root, "calls.jsonl");
  writeFileSync(callLog, "");
  const gate = join(workspace, "release-tool");

  const stderr: Buffer[] = [];
  child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./fixtures/stdio-session-agent.ts", import.meta.url))],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_ACP_TEST_AGENT_DIR: agentDir,
        PI_ACP_TEST_SESSION_DIR: sessionDir,
        PI_ACP_CALL_LOG: callLog,
        PI_ACP_TOOL_GATE: gate,
      },
    },
  );
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const updates: { sessionUpdate?: string }[] = [];
  const client = new ClientSideConnection(
    (): Client => ({
      sessionUpdate(params) {
        updates.push(params.update);
      },
      async requestPermission(): Promise<RequestPermissionResponse> {
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      },
    }),
    childStream(child),
  );

  try {
    const init = await client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "stdio-harness", version: "0" },
    });
    expect(init._meta).toMatchObject({ steering: { supported: true } });
    const created = await client.newSession({ cwd: workspace, mcpServers: [] });
    const sessionId = created.sessionId;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const before = sha256(settings);

    const switched = await client.setSessionConfigOption({
      sessionId,
      configId: "model",
      value: "faux/faux-2",
    });
    const model = switched.configOptions.find((option) => option.id === "model");
    expect(model && "currentValue" in model ? model.currentValue : undefined).toBe("faux/faux-2");
    expect(sha256(settings)).not.toBe(before);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toMatchObject({
      defaultProvider: "faux",
      defaultModel: "faux-2",
    });

    await client.setSessionConfigOption({
      sessionId,
      configId: "model",
      value: "faux/faux-1",
    });
    expect(JSON.parse(readFileSync(settings, "utf8"))).toMatchObject({
      defaultProvider: "faux",
      defaultModel: "faux-1",
    });
    const afterModel = sha256(settings);

    const promptPromise = client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "run the waiter" }],
    });
    await waitFor(() => updates.some((update) => update.sessionUpdate === "tool_call"), "tool_call");
    const injected = await client.extMethod("_session/steering", {
      sessionId,
      prompt: [{ type: "text", text: "STEER_TOKEN from the user" }],
      _meta: { steering: { idleBehavior: "promptRequired" } },
    });
    expect(injected).toEqual({ outcome: "injected" });
    writeFileSync(gate, "go\n");
    const response = await promptPromise;
    expect(response.stopReason).toBe("end_turn");
    expect(sha256(settings)).toBe(afterModel);

    const calls = readFileSync(callLog, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { n: number; model: string; text: string });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]?.text).not.toContain("STEER_TOKEN");
    expect(calls[1]?.text).toContain("STEER_TOKEN from the user");
    expect(calls[1]?.model).toBe("faux/faux-1");
    expect(JSON.parse(readFileSync(settings, "utf8")).defaultModel).toBe("faux-1");
  } catch (error) {
    const detail = Buffer.concat(stderr).toString("utf8");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`);
  } finally {
    const stdin = child.stdin as Writable;
    stdin.end();
  }
});
