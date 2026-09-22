/**
 * Transport wiring: ACP JSON-RPC over stdio (or an injected stream).
 */

import { AgentSideConnection, ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { Readable } from "node:stream";
import { PiAcpAgent, type PiAcpAgentOptions } from "./acp/agent.ts";
import { RequestIdTracker, tapRequestIds } from "./acp/request-ids.ts";
import { errorMessage, logWarn } from "./log.ts";

export interface ServerHandle {
  agent: PiAcpAgent;
  connection: AgentSideConnection;
  /** Resolves when the connection closes and sessions are torn down. */
  closed: Promise<void>;
}

export function stdioStream(): Stream {
  // Pi runtimes/extensions can redirect process.stdout.write after session creation.
  // Keep the protocol writer bound before loading them and await each complete write.
  const write = process.stdout.write.bind(process.stdout);
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        write(Buffer.from(chunk), (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  });
  return ndJsonStream(output, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
}

export function serve(options: PiAcpAgentOptions & { stream?: Stream }): ServerHandle {
  const requestIds = new RequestIdTracker();
  const stream = tapRequestIds(options.stream ?? stdioStream(), requestIds);
  let agent!: PiAcpAgent;
  const connection = new AgentSideConnection((conn) => {
    agent = new PiAcpAgent(conn, { ...options, requestIds });
    return agent;
  }, stream);
  const closed = connection.closed
    .catch((error: unknown) => {
      logWarn(`connection closed with an error: ${errorMessage(error)}`);
    })
    .then(() => agent.dispose());
  return { agent, connection, closed };
}
