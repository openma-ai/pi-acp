/**
 * Stdio ACP server with a faux model. Each model call reads the next string
 * from PI_ACP_REPLIES (a JSON array). stdout is the ACP wire.
 */
import { readFileSync } from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { serve } from "../../src/server.ts";
import { resolveSettings } from "../../src/settings.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

const agentDir = required("PI_ACP_TEST_AGENT_DIR");
const sessionDir = required("PI_ACP_TEST_SESSION_DIR");
const repliesPath = required("PI_ACP_REPLIES");

const tokensPerSecond = Number(process.env.PI_ACP_TOKENS_PER_SECOND);
const faux = fauxProvider({
  provider: "faux",
  models: [
    { id: "faux-1", name: "Faux One", reasoning: true, input: ["text", "image"], contextWindow: 100_000 },
  ],
  ...(Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 ? { tokensPerSecond } : {}),
});

let calls = 0;
const step = () => {
  const replies = JSON.parse(readFileSync(repliesPath, "utf8")) as string[];
  const reply = replies[calls] ?? `missing-reply-${calls}`;
  calls += 1;
  return fauxAssistantMessage(reply);
};
faux.setResponses(Array.from({ length: 8 }, () => step));

const modelRuntime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  refreshOnCreate: true,
});
modelRuntime.registerNativeProvider(faux.provider);
await modelRuntime.refresh({ allowNetwork: false });

const server = serve({
  settings: {
    ...resolveSettings([]),
    agentDir,
    sessionDir,
    quietStartup: true,
    model: "faux/faux-1",
  },
  modelRuntime,
});
await server.closed;
