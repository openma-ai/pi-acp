/**
 * Transport wiring: ACP JSON-RPC over stdio (or an injected stream).
 */

import { AgentSideConnection, ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { PiAcpAgent, type PiAcpAgentOptions } from "./acp/agent.ts";
import { errorMessage, logWarn } from "./log.ts";

export interface ServerHandle {
  agent: PiAcpAgent;
  connection: AgentSideConnection;
  /** Resolves when the connection closes and sessions are torn down. */
  closed: Promise<void>;
}

export function stdioStream(): Stream {
  return ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
}

export function serve(options: PiAcpAgentOptions & { stream?: Stream }): ServerHandle {
  const stream = options.stream ?? stdioStream();
  let agent!: PiAcpAgent;
  const connection = new AgentSideConnection((conn) => {
    agent = new PiAcpAgent(conn, options);
    return agent;
  }, stream);
  const closed = connection.closed
    .catch((error: unknown) => {
      logWarn(`connection closed with an error: ${errorMessage(error)}`);
    })
    .then(() => agent.dispose());
  return { agent, connection, closed };
}
