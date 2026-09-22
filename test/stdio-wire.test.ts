import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([false, true])(
  "keeps ACP frames complete on stdout (runtime takeover=%s)",
  async (takeover) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./fixtures/stdio-wire.ts", import.meta.url)),
        ...(takeover ? ["--takeover"] : []),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(code).toBe(0);
      const lines = Buffer.concat(chunks).toString("utf8").trim().split("\n");
      expect(lines).toHaveLength(9);
      const messages = lines.map((line) => JSON.parse(line));
      expect(messages[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { additionalDirectories: [] } });
      for (let i = 0; i < 8; i++) {
        expect(messages[i + 1].params).toEqual({ index: i, text: "中文🙂".repeat(32768) });
      }
      expect(Buffer.concat(errors).toString()).toBe("");
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  },
  15000,
);
