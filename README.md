<h1 align="center">openma-pi-acp</h1>

<p align="center">
  Use the <a href="https://github.com/earendil-works/pi">pi coding agent</a> from
  <a href="https://agentclientprotocol.com/">Agent Client Protocol</a> clients such as
  <a href="https://zed.dev">Zed</a> and
  <a href="https://github.com/openma-ai/backchat">Backchat</a>.
</p>

---

`@openma/pi-acp` runs pi **in-process** on the pi SDK (`createAgentSessionRuntime`)
and maps its session-event stream onto the full ACP vocabulary: streamed text and
reasoning, tool calls with diffs and terminals, extension interactions,
config options, slash commands, skills, client
filesystem/terminal delegation, and session list/load/resume/fork/close/delete.

It reuses everything pi already owns — `~/.pi/agent` settings, credentials,
sessions, extensions, skills, prompt templates, packages — so a session started
in the editor can be `/resume`d in the terminal and vice versa.

## Install

Requires Node.js **22.19 or newer** and the Pi **1.1.0** SDK family.

```bash
npm install -g @earendil-works/pi-coding-agent   # pi itself
npm install -g @openma/pi-acp
pi                                                # log in once (/login) if you have not
```

```jsonc
// Zed settings.json
{
  "agent_servers": {
    "pi": { "command": "openma-pi-acp" },
  },
}
```

Or without a global install: `{ "command": "npx", "args": ["-y", "@openma/pi-acp"] }`.

## Features

- **Streaming** — `agent_message_chunk` / `agent_thought_chunk` stream token by token.
  They share a stable `messageId`: `<parentEntryId>:<ordinal>`, taken from the entry
  already on disk when the assistant message starts (the user message, or the previous
  tool result) and the 1-based file order of this assistant among that parent's
  assistant children. `session/load` recomputes the same id, including after a process
  restart. A metadata-only boundary closes each assistant message.
- **Tool calls** — ACP kinds, human titles, absolute file locations (edit line inferred),
  structured `diff` content for `edit`/`write`, image results, shell output fenced or on a
  **display terminal** when the client supports one (`_meta.terminal_output`).
- **Native pi execution** — tools run with pi’s own behavior; the adapter adds no tool approval modes.
- **Config options** — model (grouped by provider, live from pi's model runtime), thinking
  level (only when the model reasons), auto-compaction toggle. Model/thinking changes persist
  as pi defaults, like the pi TUI.
- **Usage** — `usage_update` per assistant message with context size and cost; aggregate
  `usage` on every `session/prompt` response.
- **Compaction and retries** — `compaction_update` for manual/automatic compaction; auto-retry
  notices; queued-message state.
- **Additional directories** — `sessionCapabilities.additionalDirectories` is advertised only
  when the path boundary is working. The boundary applies only when the client sends
  `additionalDirectories` (including `[]`); omitting it leaves tool access unchanged.
  `cwd` stays the project root for skills and AGENTS.md. `load` / `resume` / `fork` do not
  revive a stored list unless `_meta.pi.restoreAdditionalDirectories` is `true`.
  The active list comes back from `session/list`. `_pi/add_directory` grows a live session.
  Other extensions are forwarded as-is.
- **Sessions** — `session/list` (pi's own store, filtered by cwd), `session/load` with full
  history replay (compaction-aware branch), `session/resume` without replay, `session/fork`
  (whole session, or inclusive of one assistant message — see below),
  `session/close`, `session/delete`, session titles, and silent restore when a client prompts
  a session the agent process forgot.
- **Slash commands** — adapter built-ins (`/status`, `/model`, `/thinking`, `/compact`,
  `/autocompact`, `/name`, `/rename`, `/session`, `/export`, `/tools`, `/skills`,
  `/steering`, `/follow-up`, `/queue`, `/bash`, `/reload`, `/changelog`) plus pi prompt
  templates, `/skill:<name>`, and extension
  commands — all advertised through `available_commands_update`.
- **MCP** — ACP `mcpServers` are registered on pi 1.1.0's MCP extension with deferred exposure. `tool_search` loads a tool before the model calls it; stdio and streamable HTTP stay supported. Connections close with the session. Legacy SSE is not advertised.
- **Client delegation** — when the client advertises `fs.readTextFile` / `fs.writeTextFile`,
  pi's `read`/`edit`/`write` go through the editor (unsaved buffers, in-editor edits); with
  `terminal`, `bash` runs in a client-owned terminal. Disable with `--no-delegation`.
- **Extension UI over ACP** — pi extension dialogs (`select`, `confirm`, `input`, `editor`)
  become `elicitation/create` forms, with a `session/request_permission` fallback for
  select/confirm on clients without form elicitation. Notifications, status, and widgets
  travel as `session_info_update` metadata.
- **Steering** — `_session/steering` injects at the next LLM boundary of a running turn
  (`{ outcome: "injected" }`), the same delivery as Enter in pi's editor, or answers
  `promptRequired` when idle. A follow-up that should wait until the turn ends (Alt+Enter)
  is a later `session/prompt`. A concurrent `session/prompt` while a turn is still running
  is delivered as a pi steer.
- **Real cancellation** — `session/cancel` aborts the turn, queued messages, bash, compaction,
  and retries.
- **Auth** — terminal auth (`openma-pi-acp --terminal-login` runs pi so you can `/login`),
  per-provider `api-key:<provider>` methods that store keys in pi's credential store,
  `oauth:<provider>` methods that run pi's browser/device-code OAuth flows through ACP
  elicitation (Anthropic, OpenAI Codex, GitHub Copilot, …), `_auth/status_update` pushes, and
  `logout`.
- **Extension attribution** — session responses list every loaded extension with the tools,
  commands, and custom entry types it owns; `tool_call`s carry `_meta.pi.extension`; extension
  `sendMessage` / `appendEntry` payloads are forwarded whole. Clients adapt third-party
  extensions (pi-subagents, pi-goal, …) on their side; the adapter never interprets them.
- **Extension events** — every `pi.events.emit` from any extension (pi-subagents, pi-goal, …) is
  forwarded as `extension_event` metadata with the payload plus two marked inferences from
  naming conventions: a lifecycle `phase` and a `correlationId`. Clients get a work-item
  stream with unknown semantics but a known lifecycle; `_pi/emit_event` sends events back in.
- **Capability-aware** — boolean config options degrade to selects, display terminals follow
  `terminal_output` / `terminal_output_delta`, diffs carry `diffStats` and add/update kind, each
  turn ends with a file-change summary, and failed turns carry a typed failure kind.

## Inclusive message fork

`initialize` advertises `sessionCapabilities.fork` together with:

```json
"agentCapabilities": {
  "_meta": { "jetbrains": { "air": { "fork": { "version": 1, "inclusive": true } } } }
}
```

That object is deep-merged with the existing `pi` and `authStatus` keys. A
`session/fork` without `_meta.jetbrains.air.fork` still copies the whole session.
With version 1, the new session keeps the source history from the start through
the chosen assistant message, including the user prompt that produced it and
earlier tool calls and results. The source session is not modified, and the new
session has a new id.

```json
{
  "_meta": {
    "jetbrains": {
      "air": {
        "fork": {
          "version": 1,
          "messageId": "<agent_message_chunk messageId>",
          "messageFingerprint": "sha256:<64 lowercase hex>",
          "messageOccurrence": 1
        }
      }
    }
  }
}
```

`messageFingerprint` is SHA-256 of the UTF-8 text of that assistant message
(text chunks only). `messageOccurrence` counts identical visible assistant texts
starting at 1. A trailing `:segment:<n>` on the id is stripped when the full id
does not match. If the id is stale or is an old counter id, the fingerprint
selects the message; a message hidden by compaction is looked up in the full
entry tree. Anything that does not match returns JSON-RPC `-32602`
(`invalidParams`) and does not fall back to a whole-session fork.

Tool calls that belong to the selected assistant message are removed, and their
results (which are stored after that message) are not copied. The message's
text and thinking stay. That keeps the model transcript legal — it does not end
on tool calls with no results — and `session/load` replay of the new session
ends on that assistant message. `session/prompt` in the new session continues
from there. Only persisted, completed messages can be a fork point.

## MCP tools over ACP

The ACP client supplies `mcpServers` when it creates, loads, or resumes a session.
Those descriptors are registered with pi's built-in MCP extension for that session
only (`pi.registerMcpServer`). The adapter does not open its own MCP client, and it
does not read `mcp.json`: pi's loader always uses the default agent directory, and
the client's list is the whole set. An empty `mcpServers` array leaves the session
with no client MCP servers. Connections close when the session does, including
stdio children (stdin close, then SIGTERM, then SIGKILL).

Each ACP server uses exposure `deferred`. Pi activates `tool_search`, and the model
loads a tool before calling it. The call is a normal ACP `tool_call` /
`tool_call_update` with kind, title, raw input, and raw output. A call another
tool makes with `executeTool` also carries `_meta.pi.parentToolCallId`. Pi's
default for its own `mcp.json` is script-only `codemode`; these client servers
are deferred instead, so the client sees the MCP tool itself. Pi converts text,
images, and embedded resources, keeps structured results, and reports MCP
errors as failed tool calls.

For example, an ACP session request can include a local project coordination server:

```json
{
  "mcpServers": [
    {
      "name": "Project",
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": [{ "name": "Authorization", "value": "Bearer <session-token>" }]
    }
  ]
}
```

A remote tool named `project.delegate` appears to Pi as
`mcp__Project__project_delegate`. Pi's names keep that shape: every character
other than letters, digits, and `_` becomes `_` (so `-` in a server name becomes
`_` in the tool name), and a name longer than 64 characters or a sanitizer
collision gets an 8-character hash suffix. The call still uses the original
remote name. Server names that differ only by `-` and `_` share one namespace;
the adapter suffixes the later one (`a_b_2`). Both stdio and streamable HTTP are
supported, including JSON and streamed HTTP responses. Legacy SSE is rejected
and reported in session diagnostics.

Header and environment values are sent literally. The session working directory
is the stdio server's cwd, and the process environment is inherited with the
client's variables overlaid. Pi follows paginated `tools/list`. A server that
cannot be described (SSE, a bad URL, a name pi will not accept) is skipped and
named in diagnostics; the other servers still connect. On reconnect, clients
should call `session/load` or `session/resume` with current descriptors and
credentials.

## Configuration

Flags win over environment variables, which win over defaults.

| Flag               | Env                     | Default       | Purpose                                                       |
| ------------------ | ----------------------- | ------------- | ------------------------------------------------------------- |
| `--agent-dir`      | `PI_CODING_AGENT_DIR`   | `~/.pi/agent` | pi config directory                                           |
| `--model`          | `PI_ACP_MODEL`          | pi default    | `provider/model[:thinking]` for new sessions                  |
| `--session-dir`    | `PI_ACP_SESSION_DIR`    | pi default    | Session storage directory                                     |
| `--trust-projects` | `PI_ACP_TRUST_PROJECTS` | off           | Load `.pi/` project resources without a stored trust decision |
| `--no-delegation`  | `PI_ACP_DELEGATION=0`   | on            | Never use client fs/terminal delegation                       |
| `--quiet-startup`  | `PI_ACP_QUIET_STARTUP`  | pi setting    | Skip the startup banner                                       |
| —                  | `PI_ACP_DEBUG`          | off           | Verbose stderr diagnostics                                    |

Project trust follows pi: `.pi/` extensions in an untrusted cwd are not loaded
until the user trusts it (`pi` interactively, `defaultProjectTrust: "always"` in
settings, `--trust-projects`, or the `_pi/trust_project` extension method).

## Architecture

```
ACP client (Zed, Backchat, …)
   │  ACP JSON-RPC over stdio
   ▼
openma-pi-acp
   ├─ src/bin.ts              CLI, terminal-login, process lifetime
   ├─ src/server.ts           AgentSideConnection over stdio (or an injected stream)
   └─ src/acp/
        ├─ agent.ts           ACP methods: initialize, auth, sessions, prompt, cancel, options, ext methods
        ├─ session.ts         one ACP session ↔ one pi AgentSessionRuntime (tools, extensions, lifecycle)
        ├─ translate.ts       pi AgentSessionEvent → session/update (pure)
        ├─ history.ts         session/load replay from pi's JSONL entries (pure)
        ├─ config-options.ts  model / thinking / auto-compaction
        ├─ commands.ts, builtin-commands.ts
        ├─ ui-context.ts      pi ExtensionUIContext over elicitation / permission
        ├─ delegation.ts      client fs + terminal backed pi tools
        ├─ mcp.ts             ACP mcpServers → pi's MCP extension (deferred tools)
        └─ extension-events.ts  pi.events → extension_event
   ▼
@earendil-works/pi-coding-agent (sessions, models, tools, extensions, skills, compaction, …)
```

`docs/metadata.md` is the registry of every `_meta` field the adapter reads or emits.

## Development

```bash
npm install
npm run typecheck
npm test            # faux-model sessions and local MCP servers; no provider requests
npm run build
node dist/bin.js --help
```

## License

Apache-2.0.
