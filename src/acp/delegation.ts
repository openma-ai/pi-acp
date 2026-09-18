/**
 * ACP client delegation: filesystem (`fs/read_text_file`, `fs/write_text_file`)
 * and terminals (`terminal/*`).
 *
 * When the client advertises these capabilities, pi's built-in `read`/`edit`/
 * `write` tools are rebuilt with operations that go through the editor (so
 * unsaved buffers are visible and edits land in the editor), and `bash` is
 * replaced by a tool that runs commands in a client-owned terminal.
 */

import type { AgentSideConnection, ClientCapabilities } from "@agentclientprotocol/sdk";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { readFile, access, mkdir } from "node:fs/promises";
import { logDebug } from "../log.ts";

export interface DelegationCapabilities {
  readTextFile: boolean;
  writeTextFile: boolean;
  terminal: boolean;
}

export function delegationFromClient(caps: ClientCapabilities | undefined): DelegationCapabilities {
  return {
    readTextFile: caps?.fs?.readTextFile === true,
    writeTextFile: caps?.fs?.writeTextFile === true,
    terminal: caps?.terminal === true,
  };
}

export interface DelegationOptions {
  conn: AgentSideConnection;
  sessionId: string;
  cwd: string;
  caps: DelegationCapabilities;
  /** Called when a client terminal is created for a tool call. */
  onTerminal?: (toolCallId: string, terminalId: string) => void;
  /** Shell settings passed through to pi's bash tool when the terminal is not delegated. */
  autoResizeImages?: boolean;
}

const TERMINAL_POLL_MS = 250;

function isTextLike(path: string): boolean {
  return !/\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tgz|tar|7z|woff2?|ttf|otf|mp[34]|mov|wasm|so|dylib|exe|bin)$/i.test(
    path,
  );
}

/** Build the delegated tool definitions; only tools whose capability is present are returned. */
export function createDelegatedTools(options: DelegationOptions): ToolDefinition[] {
  const { conn, sessionId, cwd, caps } = options;
  const tools: ToolDefinition[] = [];

  const readViaClient = async (absolutePath: string): Promise<Buffer> => {
    if (!isTextLike(absolutePath)) return readFile(absolutePath);
    try {
      const response = await conn.readTextFile({ sessionId, path: absolutePath });
      return Buffer.from(response.content, "utf8");
    } catch (error: unknown) {
      logDebug(`fs/read_text_file failed for ${absolutePath}; falling back to disk: ${String(error)}`);
      return readFile(absolutePath);
    }
  };
  const writeViaClient = async (absolutePath: string, content: string): Promise<void> => {
    await conn.writeTextFile({ sessionId, path: absolutePath, content });
  };

  if (caps.readTextFile) {
    tools.push(
      createReadToolDefinition(cwd, {
        autoResizeImages: options.autoResizeImages,
        operations: { readFile: readViaClient, access: (path) => access(path) },
      }) as unknown as ToolDefinition,
    );
  }
  if (caps.writeTextFile) {
    tools.push(
      createEditToolDefinition(cwd, {
        operations: {
          readFile: caps.readTextFile ? readViaClient : readFile,
          writeFile: writeViaClient,
          access: (path) => access(path),
        },
      }) as unknown as ToolDefinition,
    );
    tools.push(
      createWriteToolDefinition(cwd, {
        operations: {
          writeFile: writeViaClient,
          mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
        },
      }) as unknown as ToolDefinition,
    );
  }

  if (caps.terminal) {
    const bash = createBashToolDefinition(cwd) as unknown as ToolDefinition;
    // Reuse pi's schema/description; replace execution with a client terminal.
    tools.push({
      ...bash,
      renderCall: undefined,
      renderResult: undefined,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const input = params as { command: string; timeout?: number };
        const handle = await conn.createTerminal({
          sessionId,
          command: input.command,
          cwd,
          outputByteLimit: 1_000_000,
        });
        options.onTerminal?.(toolCallId, handle.id);
        let lastOutput = "";
        let killed = false;
        const onAbort = (): void => {
          killed = true;
          void handle.kill().catch(() => undefined);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const timeoutMs =
          typeof input.timeout === "number" && input.timeout > 0 ? input.timeout * 1000 : undefined;
        const timer =
          timeoutMs !== undefined
            ? setTimeout(() => {
                killed = true;
                void handle.kill().catch(() => undefined);
              }, timeoutMs)
            : undefined;
        const poll = setInterval(() => {
          void handle
            .currentOutput()
            .then((snapshot) => {
              if (snapshot.output !== lastOutput) {
                lastOutput = snapshot.output;
                onUpdate?.({ content: [{ type: "text", text: lastOutput }], details: undefined });
              }
            })
            .catch(() => undefined);
        }, TERMINAL_POLL_MS);
        try {
          const exit = await handle.waitForExit();
          const final = await handle.currentOutput();
          lastOutput = final.output;
          const exitCode = exit.exitCode ?? null;
          const text = `${lastOutput.replace(/\n+$/, "")}${killed ? "\n\n(terminated)" : ""}${
            exitCode !== null && exitCode !== 0 ? `\n\nCommand exited with code ${exitCode}` : ""
          }`;
          if ((exitCode !== null && exitCode !== 0) || killed) {
            throw new Error(text.length > 0 ? text : `Command exited with code ${String(exitCode)}`);
          }
          return {
            content: [{ type: "text", text: text.length > 0 ? text : "(no output)" }],
            details: undefined,
          };
        } finally {
          clearInterval(poll);
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          void handle.release().catch(() => undefined);
        }
      },
    });
  }

  return tools;
}
