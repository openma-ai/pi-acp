/**
 * Inclusive message fork over the in-memory ACP harness and the faux provider.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RequestError, type SessionNotification } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Fingerprint } from "../src/acp/fork-point.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall, Harness } from "./helpers/harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

type Update = SessionNotification["update"];

function fileSha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sessionFileOf(response: { _meta?: unknown }): string {
  const file = (response._meta as { pi?: { sessionFile?: unknown } } | undefined)?.pi?.sessionFile;
  if (typeof file !== "string" || file.length === 0) throw new Error("missing session file");
  return file;
}

function assistantMessages(updates: Update[]): { messageId: string; text: string }[] {
  const order: string[] = [];
  const text = new Map<string, string>();
  for (const update of updates) {
    if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk")
      continue;
    const id = update.messageId;
    if (typeof id !== "string" || id.length === 0) continue;
    if (!text.has(id)) {
      order.push(id);
      text.set(id, "");
    }
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      text.set(id, `${text.get(id) ?? ""}${update.content.text}`);
    }
  }
  return order
    .filter((id) => (text.get(id) ?? "").length > 0)
    .map((id) => ({ messageId: id, text: text.get(id) ?? "" }));
}

function userTexts(updates: Update[]): string[] {
  return updates
    .filter((update) => update.sessionUpdate === "user_message_chunk" && update.content.type === "text")
    .map((update) =>
      update.sessionUpdate === "user_message_chunk" && update.content.type === "text"
        ? update.content.text
        : "",
    );
}

function forkMeta(
  messageId: string,
  text: string,
  occurrence = 1,
): {
  jetbrains: {
    air: {
      fork: { version: number; messageId: string; messageFingerprint: string; messageOccurrence: number };
    };
  };
} {
  return {
    jetbrains: {
      air: {
        fork: {
          version: 1,
          messageId,
          messageFingerprint: sha256Fingerprint(text),
          messageOccurrence: occurrence,
        },
      },
    },
  };
}

describe("inclusive session/fork", () => {
  it("forks at a message, keeps stable ids, and rejects a miss", async () => {
    harness = await Harness.create();
    const init = await harness.initialize();
    expect(init.agentCapabilities?.sessionCapabilities?.fork).toEqual({});
    expect(init.agentCapabilities?._meta).toMatchObject({
      authStatus: {},
      pi: { delegation: expect.any(Object) },
      jetbrains: { air: { fork: { version: 1, inclusive: true } } },
    });

    const created = await harness.client.newSession({ cwd: harness.workspace, mcpServers: [] });
    const sessionId = created.sessionId;
    const sourceFile = sessionFileOf(created);
    harness.respond(fauxAssistantMessage("SAME"));
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "round-one" }] });
    harness.respond(fauxAssistantMessage("SAME"));
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "round-two" }] });
    harness.respond(fauxAssistantMessage("THIRD"));
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "round-three" }] });

    const live = assistantMessages(harness.updatesFor(sessionId));
    expect(live.map((message) => message.text)).toEqual(["SAME", "SAME", "THIRD"]);
    expect(new Set(live.map((message) => message.messageId)).size).toBe(3);
    expect(
      live.every((message) => !/^m\d+$/.test(message.messageId) && !/^h\d+$/.test(message.messageId)),
    ).toBe(true);

    harness.notifications.length = 0;
    await harness.client.loadSession({ sessionId, cwd: harness.workspace, mcpServers: [] });
    await harness.settle();
    const replay = assistantMessages(harness.updatesFor(sessionId));
    expect(replay).toEqual(live);

    const before = fileSha(sourceFile);
    const listed = await harness.client.listSessions({ cwd: harness.workspace });
    await expect(
      harness.client.unstable_forkSession({
        sessionId,
        cwd: harness.workspace,
        _meta: { jetbrains: { air: { fork: { version: 2, messageId: live[1]!.messageId } } } },
      }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("Unsupported jetbrains.air.fork version"),
    });
    await expect(
      harness.client.unstable_forkSession({
        sessionId,
        cwd: harness.workspace,
        _meta: { jetbrains: { air: { fork: { version: 1, messageId: "missing-id" } } } },
      }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("Fork point message missing-id was not found in session"),
      data: { messageId: "missing-id" },
    });
    const listedAfterReject = await harness.client.listSessions({ cwd: harness.workspace });
    expect(listedAfterReject.sessions.map((session) => session.sessionId).sort()).toEqual(
      listed.sessions.map((session) => session.sessionId).sort(),
    );
    expect(fileSha(sourceFile)).toBe(before);

    const forked = await harness.client.unstable_forkSession({
      sessionId,
      cwd: harness.workspace,
      _meta: forkMeta(live[1]!.messageId, "SAME", 2),
    });
    expect(forked.sessionId).not.toBe(sessionId);
    expect(fileSha(sourceFile)).toBe(before);

    harness.notifications.length = 0;
    await harness.client.loadSession({ sessionId: forked.sessionId, cwd: harness.workspace, mcpServers: [] });
    await harness.settle();
    const forkReplay = assistantMessages(harness.updatesFor(forked.sessionId));
    expect(forkReplay.map((message) => message.text)).toEqual(["SAME", "SAME"]);
    expect(forkReplay[1]?.messageId).toBe(live[1]!.messageId);
    const users = userTexts(harness.updatesFor(forked.sessionId));
    expect(users).toEqual(expect.arrayContaining(["round-one", "round-two"]));
    expect(users).not.toContain("round-three");

    harness.respond(fauxAssistantMessage("NEXT"));
    await harness.client.prompt({
      sessionId: forked.sessionId,
      prompt: [{ type: "text", text: "round-four" }],
    });
    expect(harness.text(forked.sessionId)).toContain("NEXT");
    expect(harness.text(forked.sessionId)).not.toContain("THIRD");

    harness.notifications.length = 0;
    await harness.client.loadSession({ sessionId, cwd: harness.workspace, mcpServers: [] });
    await harness.settle();
    expect(assistantMessages(harness.updatesFor(sessionId)).map((message) => message.text)).toEqual([
      "SAME",
      "SAME",
      "THIRD",
    ]);

    const fallback = await harness.client.unstable_forkSession({
      sessionId,
      cwd: harness.workspace,
      _meta: forkMeta("m2", "SAME", 2),
    });
    harness.notifications.length = 0;
    await harness.client.loadSession({
      sessionId: fallback.sessionId,
      cwd: harness.workspace,
      mcpServers: [],
    });
    await harness.settle();
    const fallbackReplay = assistantMessages(harness.updatesFor(fallback.sessionId));
    expect(fallbackReplay.map((message) => message.text)).toEqual(["SAME", "SAME"]);
    expect(fallbackReplay[1]?.messageId).toBe(live[1]!.messageId);

    const whole = await harness.client.unstable_forkSession({ sessionId, cwd: harness.workspace });
    harness.notifications.length = 0;
    await harness.client.loadSession({ sessionId: whole.sessionId, cwd: harness.workspace, mcpServers: [] });
    await harness.settle();
    expect(assistantMessages(harness.updatesFor(whole.sessionId)).map((message) => message.text)).toEqual([
      "SAME",
      "SAME",
      "THIRD",
    ]);
  });

  it("strips tool calls on the fork point so the new session can continue", async () => {
    harness = await Harness.create();
    await harness.initialize();
    const sessionId = await harness.newSession();
    const note = join(harness.workspace, "note.txt");
    writeFileSync(note, "hello file\n");
    harness.respond(
      fauxAssistantMessage([fauxText("reading"), fauxToolCall("read", { path: "note.txt" })]),
      fauxAssistantMessage("after-tool"),
    );
    await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "read the note" }] });
    const live = assistantMessages(harness.updatesFor(sessionId));
    expect(live.map((message) => message.text)).toEqual(["reading", "after-tool"]);
    expect(harness.updatesFor(sessionId).some((update) => update.sessionUpdate === "tool_call")).toBe(true);

    const forked = await harness.client.unstable_forkSession({
      sessionId,
      cwd: harness.workspace,
      _meta: forkMeta(`${live[0]!.messageId}:segment:1`, "reading"),
    });
    harness.notifications.length = 0;
    await harness.client.loadSession({ sessionId: forked.sessionId, cwd: harness.workspace, mcpServers: [] });
    await harness.settle();
    expect(assistantMessages(harness.updatesFor(forked.sessionId)).map((message) => message.text)).toEqual([
      "reading",
    ]);
    expect(harness.text(forked.sessionId)).not.toContain("after-tool");

    const forkFile = sessionFileOf(forked);
    const forkedRaw = readFileSync(forkFile, "utf8");
    expect(forkedRaw).not.toContain('"toolCall"');
    expect(forkedRaw).not.toContain("after-tool");

    harness.respond(fauxAssistantMessage("continued"));
    await harness.client.prompt({ sessionId: forked.sessionId, prompt: [{ type: "text", text: "go on" }] });
    expect(harness.text(forked.sessionId)).toContain("continued");
  });

  it("surfaces invalidParams as a RequestError", async () => {
    harness = await Harness.create();
    await harness.initialize();
    const sessionId = await harness.newSession();
    try {
      await harness.client.unstable_forkSession({
        sessionId,
        cwd: harness.workspace,
        _meta: { jetbrains: { air: { fork: { version: 1 } } } },
      });
      expect.unreachable("fork should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError);
      expect(error).toMatchObject({ code: -32602 });
      expect((error as RequestError).message).toContain("messageId must be a non-empty string");
    }
  });
});
