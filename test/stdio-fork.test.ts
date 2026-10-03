/**
 * Inclusive fork across two real stdio processes. The model is the local faux
 * provider; nothing dials a production API.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  RequestError,
  type Client,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk";
import { afterEach, expect, it } from "vitest";
import { sha256Fingerprint } from "../src/acp/fork-point.ts";

let child: ChildProcessWithoutNullStreams | undefined;
let root: string | undefined;

afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

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

function spawnAgent(agentDir: string, sessionDir: string, replies: string): ChildProcessWithoutNullStreams {
  const stderr: Buffer[] = [];
  const proc = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./fixtures/stdio-fork-agent.ts", import.meta.url))],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_ACP_TEST_AGENT_DIR: agentDir,
        PI_ACP_TEST_SESSION_DIR: sessionDir,
        PI_ACP_REPLIES: replies,
      },
    },
  );
  proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  proc.on("exit", () => {
    if (stderr.length > 0 && proc.exitCode !== 0 && proc.exitCode !== null) {
      process.stderr.write(Buffer.concat(stderr));
    }
  });
  return proc;
}

async function stopChild(proc: ChildProcessWithoutNullStreams): Promise<void> {
  proc.stdin.end();
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(timer);
}

function assistantMessages(updates: SessionNotification["update"][]): { messageId: string; text: string }[] {
  const order: string[] = [];
  const text = new Map<string, string>();
  for (const update of updates) {
    if (update.sessionUpdate !== "agent_message_chunk") continue;
    const id = update.messageId;
    if (typeof id !== "string" || id.length === 0 || update.content.type !== "text") continue;
    if (!text.has(id)) {
      order.push(id);
      text.set(id, "");
    }
    text.set(id, `${text.get(id) ?? ""}${update.content.text}`);
  }
  return order
    .filter((id) => (text.get(id) ?? "").length > 0)
    .map((id) => ({ messageId: id, text: text.get(id) ?? "" }));
}

it("restarts the process and forks with an old counter id plus fingerprint", async () => {
  root = mkdtempSync(join(tmpdir(), "pi-acp-stdio-fork-"));
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const workspace = join(root, "work");
  mkdirSync(agentDir);
  mkdirSync(sessionDir);
  mkdirSync(workspace);
  const replies = join(root, "replies.json");
  writeFileSync(replies, JSON.stringify(["SAME", "SAME", "THIRD"]));

  const updates: SessionNotification[] = [];
  child = spawnAgent(agentDir, sessionDir, replies);
  const client = new ClientSideConnection(
    (): Client => ({
      sessionUpdate(params) {
        updates.push(params);
      },
      async requestPermission(): Promise<RequestPermissionResponse> {
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      },
    }),
    childStream(child),
  );

  const init = await client.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "stdio-fork", version: "0" },
  });
  expect(init.agentCapabilities?.sessionCapabilities?.fork).toEqual({});
  expect(init.agentCapabilities?._meta).toMatchObject({
    jetbrains: { air: { fork: { version: 1, inclusive: true } } },
  });
  const created = await client.newSession({ cwd: workspace, mcpServers: [] });
  const sessionId = created.sessionId;
  await client.prompt({ sessionId, prompt: [{ type: "text", text: "round-one" }] });
  await client.prompt({ sessionId, prompt: [{ type: "text", text: "round-two" }] });
  await client.prompt({ sessionId, prompt: [{ type: "text", text: "round-three" }] });
  const live = assistantMessages(
    updates.filter((notice) => notice.sessionId === sessionId).map((notice) => notice.update),
  );
  expect(live.map((message) => message.text)).toEqual(["SAME", "SAME", "THIRD"]);
  const secondId = live[1]!.messageId;
  await stopChild(child);
  child = undefined;

  writeFileSync(replies, JSON.stringify(["NEXT"]));
  const restarted: SessionNotification[] = [];
  child = spawnAgent(agentDir, sessionDir, replies);
  const again = new ClientSideConnection(
    (): Client => ({
      sessionUpdate(params) {
        restarted.push(params);
      },
      async requestPermission(): Promise<RequestPermissionResponse> {
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      },
    }),
    childStream(child),
  );
  const reinit = await again.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "stdio-fork", version: "0" },
  });
  expect(reinit.agentCapabilities?.sessionCapabilities?.fork).toEqual({});
  expect(reinit.agentCapabilities?._meta).toMatchObject({
    authStatus: {},
    jetbrains: { air: { fork: { version: 1, inclusive: true } } },
  });

  await again.loadSession({ sessionId, cwd: workspace, mcpServers: [] });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const reloaded = assistantMessages(
    restarted.filter((notice) => notice.sessionId === sessionId).map((notice) => notice.update),
  );
  expect(reloaded).toEqual(live);

  const sourceBefore = readFileSync(
    (created._meta as { pi?: { sessionFile?: string } }).pi!.sessionFile!,
    "utf8",
  );
  try {
    await again.unstable_forkSession({
      sessionId,
      cwd: workspace,
      _meta: { jetbrains: { air: { fork: { version: 1, messageId: "missing-id" } } } },
    });
    expect.unreachable("missing fork point should fail");
  } catch (error) {
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: -32602, data: { messageId: "missing-id" } });
  }
  expect(readFileSync((created._meta as { pi?: { sessionFile?: string } }).pi!.sessionFile!, "utf8")).toBe(
    sourceBefore,
  );

  const forked = await again.unstable_forkSession({
    sessionId,
    cwd: workspace,
    _meta: {
      jetbrains: {
        air: {
          fork: {
            version: 1,
            messageId: "m2",
            messageFingerprint: sha256Fingerprint("SAME"),
            messageOccurrence: 2,
          },
        },
      },
    },
  });
  expect(forked.sessionId).not.toBe(sessionId);
  expect(readFileSync((created._meta as { pi?: { sessionFile?: string } }).pi!.sessionFile!, "utf8")).toBe(
    sourceBefore,
  );

  restarted.length = 0;
  await again.loadSession({ sessionId: forked.sessionId, cwd: workspace, mcpServers: [] });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const forkReplay = assistantMessages(
    restarted.filter((notice) => notice.sessionId === forked.sessionId).map((notice) => notice.update),
  );
  expect(forkReplay.map((message) => message.text)).toEqual(["SAME", "SAME"]);
  expect(forkReplay[1]?.messageId).toBe(secondId);
  const users = restarted
    .filter((notice) => notice.sessionId === forked.sessionId)
    .map((notice) => notice.update)
    .filter((update) => update.sessionUpdate === "user_message_chunk" && update.content.type === "text")
    .map((update) =>
      update.sessionUpdate === "user_message_chunk" && update.content.type === "text"
        ? update.content.text
        : "",
    );
  expect(users).toContain("round-one");
  expect(users).toContain("round-two");
  expect(users).not.toContain("round-three");

  await again.prompt({ sessionId: forked.sessionId, prompt: [{ type: "text", text: "round-four" }] });
  const continued = assistantMessages(
    restarted.filter((notice) => notice.sessionId === forked.sessionId).map((notice) => notice.update),
  );
  expect(continued.map((message) => message.text)).toContain("NEXT");
  expect(continued.map((message) => message.text)).not.toContain("THIRD");
});
