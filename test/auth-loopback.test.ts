/** captureApiKeyViaUrl: the loopback key-entry page behind a URL elicitation. */

import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { captureApiKeyViaUrl } from "../src/acp/auth-loopback.ts";
import { AuthFlowCancelled } from "../src/acp/auth-interaction.ts";

interface MockConn {
  requests: { url: string; elicitationId: string }[];
  completes: { elicitationId: string }[];
  action: "accept" | "decline" | "cancel";
  completeFails: boolean;
}

function conn(behavior: Partial<MockConn> = {}) {
  const state: MockConn = {
    requests: [],
    completes: [],
    action: behavior.action ?? "accept",
    completeFails: behavior.completeFails ?? false,
  };
  const mock = {
    createElicitation: (params: { elicitationId: string; url: string }) => {
      state.requests.push({ url: params.url, elicitationId: params.elicitationId });
      return Promise.resolve({ action: state.action });
    },
    completeElicitation: (params: { elicitationId: string }) => {
      if (state.completeFails) return Promise.reject(new Error("complete failed"));
      state.completes.push(params);
      return Promise.resolve();
    },
  };
  return { state, conn: mock as unknown as AgentSideConnection };
}

/** The elicitation goes out after the server binds — wait for it. */
async function firstUrl(state: MockConn): Promise<string> {
  for (let i = 0; i < 200 && state.requests.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const url = state.requests[0]?.url;
  if (url === undefined) throw new Error("no elicitation was issued");
  return url;
}

const PROVIDER = "keyable";

async function submitKey(url: string, key = "sk-test") {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `apiKey=${encodeURIComponent(key)}`,
  });
}

describe("captureApiKeyViaUrl", () => {
  it("serves the form, accepts the posted key, and completes the elicitation", async () => {
    const { state, conn: c } = conn();
    const pending = captureApiKeyViaUrl({ conn: c, requestId: 7, provider: PROVIDER });
    const url = await firstUrl(state);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    const page = await fetch(url);
    const html = await page.text();
    expect(html).toContain("<form");
    expect(html).toContain(PROVIDER);
    const posted = await submitKey(url);
    expect(posted.status).toBe(200);
    expect(await posted.text()).toContain("close");
    expect(await pending).toBe("sk-test");
    expect(state.completes).toEqual([{ elicitationId: state.requests[0]?.elicitationId }]);
  });

  it("rejects with cancelled when the client declines the elicitation", async () => {
    const { conn: c } = conn({ action: "decline" });
    await expect(captureApiKeyViaUrl({ conn: c, requestId: 1, provider: PROVIDER })).rejects.toBeInstanceOf(
      AuthFlowCancelled,
    );
  });

  it("rejects with the elicitation error when create fails", async () => {
    const mock = {
      createElicitation: () => Promise.reject(new Error("no url mode")),
      completeElicitation: () => Promise.resolve(),
    };
    await expect(
      captureApiKeyViaUrl({
        conn: mock as unknown as AgentSideConnection,
        requestId: 8,
        provider: PROVIDER,
      }),
    ).rejects.toThrow("no url mode");
    const weird = {
      createElicitation: () => Promise.reject("bail"),
      completeElicitation: () => Promise.resolve(),
    };
    await expect(
      captureApiKeyViaUrl({
        conn: weird as unknown as AgentSideConnection,
        requestId: 9,
        provider: PROVIDER,
      }),
    ).rejects.toThrow("bail");
  });

  it("rejects with cancelled when the signal aborts", async () => {
    const { state, conn: c } = conn();
    const controller = new AbortController();
    const pending = captureApiKeyViaUrl({
      conn: c,
      requestId: 2,
      provider: PROVIDER,
      signal: controller.signal,
    });
    await firstUrl(state);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AuthFlowCancelled);
  });

  it("still resolves the key when completing the elicitation fails", async () => {
    const { state, conn: c } = conn({ completeFails: true });
    const pending = captureApiKeyViaUrl({ conn: c, requestId: 3, provider: PROVIDER });
    const url = await firstUrl(state);
    await submitKey(url);
    expect(await pending).toBe("sk-test");
  });

  it("404s unknown paths, 405s wrong methods, and 400s an empty key", async () => {
    const { state, conn: c } = conn();
    const pending = captureApiKeyViaUrl({ conn: c, requestId: 4, provider: PROVIDER });
    const url = await firstUrl(state);
    expect((await fetch(`http://${new URL(url).host}/nope`)).status).toBe(404);
    expect((await fetch(url, { method: "PUT" })).status).toBe(405);
    const empty = await submitKey(url, "");
    expect(empty.status).toBe(400);
    const missing = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "other=1",
    });
    expect(missing.status).toBe(400);
    await submitKey(url);
    await pending;
  });

  it("works without an abort signal", async () => {
    const { state, conn: c } = conn();
    const pending = captureApiKeyViaUrl({ conn: c, requestId: 5, provider: PROVIDER });
    const url = await firstUrl(state);
    await submitKey(url, "k2");
    expect(await pending).toBe("k2");
  });
});
