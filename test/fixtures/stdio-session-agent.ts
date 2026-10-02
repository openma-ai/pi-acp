/**
 * Real stdio ACP server (`serve`) with pi's runtime and a faux model.
 * stdout is the ACP wire. Model-call transcripts go to PI_ACP_CALL_LOG.
 */
import { appendFileSync } from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { serve } from "../../src/server.ts";
import { resolveSettings } from "../../src/settings.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

function contextText(context: Context): string {
  const chunks: string[] = [];
  for (const message of context.messages) {
    const content = message.content;
    if (typeof content === "string") {
      chunks.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
        chunks.push(block.text);
      }
    }
  }
  return chunks.join("\n");
}

const agentDir = required("PI_ACP_TEST_AGENT_DIR");
const sessionDir = required("PI_ACP_TEST_SESSION_DIR");
const callLog = required("PI_ACP_CALL_LOG");
const gate = required("PI_ACP_TOOL_GATE");

const faux = fauxProvider({
  provider: "faux",
  models: [
    { id: "faux-1", name: "Faux One", reasoning: true, input: ["text", "image"], contextWindow: 100_000 },
    { id: "faux-2", name: "Faux Two", reasoning: false, input: ["text"], contextWindow: 50_000 },
  ],
});

let calls = 0;
const record = (context: Context, model: Model<string>): void => {
  calls += 1;
  appendFileSync(
    callLog,
    `${JSON.stringify({ n: calls, model: `${model.provider}/${model.id}`, text: contextText(context) })}\n`,
  );
};
const command = `while [ ! -f '${gate.replaceAll("'", `'\\''`)}' ]; do sleep 0.05; done`;
faux.setResponses([
  (context, _options, _state, model) => {
    record(context, model);
    return fauxAssistantMessage([fauxToolCall("bash", { command })]);
  },
  (context, _options, _state, model) => {
    record(context, model);
    return fauxAssistantMessage("after-steer");
  },
  (context, _options, _state, model) => {
    record(context, model);
    return fauxAssistantMessage("extra");
  },
]);

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
