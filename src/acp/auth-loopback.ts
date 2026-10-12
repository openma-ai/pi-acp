/**
 * Spec-compliant secret entry for clients that support `elicitation/create`
 * mode "url" but not the openma `_meta["api-key"]` extension: the client opens
 * a one-shot 127.0.0.1 page, the browser POSTs the key back over loopback, and
 * the key never leaves the machine or touches the protocol.
 */

import type { AgentSideConnection, JsonRpcId } from "@agentclientprotocol/sdk";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AuthFlowCancelled } from "./auth-interaction.ts";
import { errorMessage, logDebug } from "../log.ts";
import { piMeta } from "./meta.ts";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function page(body: string): string {
  return [
    '<!doctype html><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>pi-acp login</title>",
    "<style>",
    "body{font-family:system-ui,sans-serif;max-width:26rem;margin:4rem auto;padding:0 1rem;color:#1c1917}",
    "input{width:100%;box-sizing:border-box;padding:.5rem;font-size:1rem}",
    "button{margin-top:1rem;padding:.5rem 1rem;font-size:1rem}",
    ".note{color:#57534e;font-size:.875rem}",
    "</style>",
    body,
  ].join("\n");
}

async function serveKeyPage(
  provider: string,
  token: string,
): Promise<{
  server: Server;
  url: string;
  submission: Promise<string>;
  reject: (error: Error) => void;
}> {
  let resolveKey!: (key: string) => void;
  let rejectKey!: (error: Error) => void;
  const submission = new Promise<string>((resolve, reject) => {
    resolveKey = resolve;
    rejectKey = reject;
  });
  const form = page(
    `<h1>Enter your ${escapeHtml(provider)} API key</h1>` +
      '<form method="post">' +
      '<input type="password" name="apiKey" autocomplete="off" autofocus required ' +
      'placeholder="Paste your API key">' +
      '<button type="submit">Store key</button></form>' +
      '<p class="note">This page is served by pi-acp over loopback only; ' +
      "the key is stored in pi's local credential store and never sent elsewhere.</p>",
  );
  const done = page("<h1>Key received</h1><p>You can close this tab and return to your client.</p>");
  const missing = page("<h1>No key entered</h1><p>Go back and paste your API key.</p>");

  const server = createServer((req, res) => {
    const url = new URL(req.url as string, "http://127.0.0.1");
    if (url.pathname !== `/${token}`) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(form);
      return;
    }
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const key = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("apiKey")?.trim() ?? "";
        if (key.length === 0) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(missing);
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(done);
        resolveKey(key);
      });
      return;
    }
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("method not allowed");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}/${token}`, submission, reject: rejectKey };
}

/**
 * Open a loopback key-entry page through a URL elicitation and resolve with the
 * submitted key. Rejects with AuthFlowCancelled when the client reports
 * decline/cancel, or with the elicitation error itself.
 */
export async function captureApiKeyViaUrl(options: {
  conn: AgentSideConnection;
  requestId: JsonRpcId;
  provider: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { conn, requestId, provider, signal } = options;
  const token = randomBytes(16).toString("hex");
  const { server, url, submission, reject } = await serveKeyPage(provider, token);
  const onAbort = (): void => reject(new AuthFlowCancelled("aborted"));
  signal?.addEventListener("abort", onAbort);
  const elicitationId = `pi-auth-${token.slice(0, 12)}`;
  try {
    const responsePromise = conn.createElicitation({
      mode: "url",
      requestId,
      elicitationId,
      url,
      message: `Enter your ${provider} API key in the page that just opened (served by pi-acp on this machine).`,
      _meta: piMeta({ auth: { provider, event: "api_key" } }),
    });
    void responsePromise.then(
      (response) => {
        if (response.action !== "accept") reject(new AuthFlowCancelled(response.action));
      },
      (error: unknown) => reject(error instanceof Error ? error : new Error(errorMessage(error))),
    );
    const key = await submission;
    try {
      await conn.completeElicitation({ elicitationId });
    } catch (error: unknown) {
      logDebug(`completeElicitation(${elicitationId}) failed: ${errorMessage(error)}`);
    }
    return key;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    server.close();
  }
}
