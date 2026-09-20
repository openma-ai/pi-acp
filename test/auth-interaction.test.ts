import { describe, expect, it } from "vitest";
import type { CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk";
import { AuthFlowCancelled, createAcpAuthInteraction } from "../src/acp/auth-interaction.ts";

interface FakeConn {
  requests: CreateElicitationRequest[];
  completed: string[];
  createElicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse>;
  completeElicitation(params: { elicitationId: string }): Promise<void>;
}

function fakeConn(respond: (request: CreateElicitationRequest) => CreateElicitationResponse): FakeConn {
  const conn: FakeConn = {
    requests: [],
    completed: [],
    async createElicitation(request) {
      conn.requests.push(request);
      return respond(request);
    },
    async completeElicitation(params) {
      conn.completed.push(params.elicitationId);
    },
  };
  return conn;
}

describe("AuthInteraction over ACP elicitation", () => {
  it("opens auth URLs as url elicitations and completes them", async () => {
    const conn = fakeConn(() => ({ action: "accept" }));
    const interaction = createAcpAuthInteraction({
      conn,
      requestId: 7,
      provider: "anthropic",
      urlElicitation: true,
      formElicitation: true,
      signal: new AbortController().signal,
    });
    interaction.notify({ type: "auth_url", url: "https://example.com/login", instructions: "Go" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(conn.requests[0]).toMatchObject({
      mode: "url",
      requestId: 7,
      url: "https://example.com/login",
      message: "Go",
    });
    await interaction.finish();
    expect(conn.completed).toEqual([(conn.requests[0] as { elicitationId: string }).elicitationId]);
  });

  it("answers select prompts through forms and falls back to the first option", async () => {
    const conn = fakeConn(() => ({ action: "accept", content: { choice: "device" } }));
    const withForm = createAcpAuthInteraction({
      conn,
      requestId: "a",
      provider: "openai-codex",
      urlElicitation: false,
      formElicitation: true,
      signal: new AbortController().signal,
    });
    const options = [
      { id: "browser", label: "Browser" },
      { id: "device", label: "Device code" },
    ];
    expect(await withForm.prompt({ type: "select", message: "How?", options })).toBe("device");
    expect(conn.requests[0]).toMatchObject({ mode: "form", requestId: "a", message: "How?" });

    const withoutForm = createAcpAuthInteraction({
      conn,
      requestId: "a",
      provider: "openai-codex",
      urlElicitation: true,
      formElicitation: false,
      signal: new AbortController().signal,
    });
    expect(await withoutForm.prompt({ type: "select", message: "How?", options })).toBe("browser");
  });

  it("shows the login URL inside the manual-code form when URLs cannot be opened", async () => {
    const conn = fakeConn(() => ({ action: "accept", content: { code: "abc123" } }));
    const interaction = createAcpAuthInteraction({
      conn,
      requestId: 1,
      provider: "anthropic",
      urlElicitation: false,
      formElicitation: true,
      signal: new AbortController().signal,
    });
    interaction.notify({ type: "auth_url", url: "https://example.com/authorize", instructions: "Open this" });
    const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
    expect(code).toBe("abc123");
    expect(conn.requests).toHaveLength(1);
    expect(conn.requests[0]?.message).toContain("https://example.com/authorize");
    expect(conn.requests[0]).toMatchObject({ requestedSchema: { required: ["code"] } });
  });

  it("waits on the prompt signal for manual codes without forms and rejects on abort", async () => {
    const conn = fakeConn(() => ({ action: "accept" }));
    const flow = new AbortController();
    const interaction = createAcpAuthInteraction({
      conn,
      requestId: 1,
      provider: "anthropic",
      urlElicitation: true,
      formElicitation: false,
      signal: flow.signal,
    });
    const manual = new AbortController();
    const pending = interaction.prompt({ type: "manual_code", message: "Paste", signal: manual.signal });
    manual.abort();
    await expect(pending).rejects.toBeInstanceOf(AuthFlowCancelled);
    expect(conn.requests).toHaveLength(0);
  });

  it("treats a declined form as a cancelled flow", async () => {
    const conn = fakeConn(() => ({ action: "decline" }));
    const interaction = createAcpAuthInteraction({
      conn,
      requestId: 1,
      provider: "x",
      urlElicitation: false,
      formElicitation: true,
      signal: new AbortController().signal,
    });
    await expect(interaction.prompt({ type: "secret", message: "Key?" })).rejects.toBeInstanceOf(
      AuthFlowCancelled,
    );
  });
});
