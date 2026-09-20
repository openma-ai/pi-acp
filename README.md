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
reasoning, tool calls with diffs and terminals, plans, permission requests,
session modes, config options, slash commands, skills, MCP servers, client
filesystem/terminal delegation, and session list/load/resume/fork/close/delete.

It reuses everything pi already owns — `~/.pi/agent` settings, credentials,
sessions, extensions, skills, prompt templates, packages — so a session started
in the editor can be `/resume`d in the terminal and vice versa.

## Install

```bash
npm install -g @earendil-works/pi-coding-agent   # pi itself (>= 0.85)
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

- **Streaming** — `agent_message_chunk` / `agent_thought_chunk` with stable message ids;
  a metadata-only boundary closes each assistant message.
- **Tool calls** — ACP kinds, human titles, absolute file locations (edit line inferred),
  structured `diff` content for `edit`/`write`, image results, shell output fenced or on a
  **display terminal** when the client supports one (`_meta.terminal_output`).
- **Permissions as session modes** — `read-only` / `ask` / `full-access`. `ask` routes every
  mutating tool (shell, edit, write, MCP, unknown extension tools) through
  `session/request_permission` with allow/reject once/always; `read-only` blocks them before
  they run. Also exposed as the `mode` config option for clients that only render those.
- **Config options** — model (grouped by provider, live from pi's model runtime), thinking
  level (only when the model reasons), auto-compaction toggle. Model/thinking changes persist
  as pi defaults, like the pi TUI.
- **Usage** — `usage_update` per assistant message with context size and cost; aggregate
  `usage` on every `session/prompt` response.
- **Compaction and retries** — `compaction_update` for manual/automatic compaction; auto-retry
  notices; queued-message state.
- **Additional directories** — pi has no multi-root primitive and the adapter invents none: the
  [`pi-add-dir`](https://pi.dev/packages/pi-add-dir) extension is bundled and loaded into every
  session, and ACP `additionalDirectories` run its `/add-dir` flow (AGENTS.md, CLAUDE.md, skills).
  Other extensions are forwarded as-is.
- **Sessions** — `session/list` (pi's own store, filtered by cwd), `session/load` with full
  history replay (compaction-aware branch), `session/resume` without replay, `session/fork`,
  `session/close`, `session/delete`, session titles, and silent restore when a client prompts
  a session the agent process forgot.
- **Slash commands** — adapter built-ins (`/status`, `/model`, `/thinking`, `/mode`, `/compact`,
  `/autocompact`, `/name`, `/rename`, `/session`, `/export`, `/tools`, `/mcp`, `/skills`,
  `/steering`, `/follow-up`, `/queue`, `/bash`, `/reload`, `/changelog`) plus pi prompt
  templates, `/skill:<name>`, and extension
  commands — all advertised through `available_commands_update`.
- **MCP servers** — per-session `mcpServers` (stdio + streamable HTTP) mount as pi tools named
  `mcp__<server>__<tool>`; a failing server is reported, never fatal.
- **Client delegation** — when the client advertises `fs.readTextFile` / `fs.writeTextFile`,
  pi's `read`/`edit`/`write` go through the editor (unsaved buffers, in-editor edits); with
  `terminal`, `bash` runs in a client-owned terminal. Disable with `--no-delegation`.
- **Extension UI over ACP** — pi extension dialogs (`select`, `confirm`, `input`, `editor`)
  become `elicitation/create` forms, with a `session/request_permission` fallback for
  select/confirm on clients without form elicitation. Notifications, status, and widgets
  travel as `session_info_update` metadata.
- **Steering** — `_session/steering` injects into a running turn (`{ outcome: "injected" }`)
  or answers `promptRequired` when idle; a concurrent `session/prompt` while a turn runs
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

## Configuration

Flags win over environment variables, which win over defaults.

| Flag                | Env                      | Default       | Purpose                                                       |
| ------------------- | ------------------------ | ------------- | ------------------------------------------------------------- |
| `--agent-dir`       | `PI_CODING_AGENT_DIR`    | `~/.pi/agent` | pi config directory                                           |
| `--permission-mode` | `PI_ACP_PERMISSION_MODE` | `ask`         | `read-only` / `ask` / `full-access`                           |
| `--model`           | `PI_ACP_MODEL`           | pi default    | `provider/model[:thinking]` for new sessions                  |
| `--session-dir`     | `PI_ACP_SESSION_DIR`     | pi default    | Session storage directory                                     |
| `--trust-projects`  | `PI_ACP_TRUST_PROJECTS`  | off           | Load `.pi/` project resources without a stored trust decision |
| `--no-delegation`   | `PI_ACP_DELEGATION=0`    | on            | Never use client fs/terminal delegation                       |
| `--quiet-startup`   | `PI_ACP_QUIET_STARTUP`   | pi setting    | Skip the startup banner                                       |
| —                   | `PI_ACP_DEBUG`           | off           | Verbose stderr diagnostics                                    |

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
        ├─ agent.ts           ACP methods: initialize, auth, sessions, prompt, cancel, modes, options, ext methods
        ├─ session.ts         one ACP session ↔ one pi AgentSessionRuntime (tools, gate, lifecycle)
        ├─ translate.ts       pi AgentSessionEvent → session/update (pure)
        ├─ history.ts         session/load replay from pi's JSONL entries (pure)
        ├─ permissions.ts     modes + tool-call gate (inline pi extension)
        ├─ config-options.ts  mode / model / thinking / auto-compaction
        ├─ commands.ts, builtin-commands.ts
        ├─ ui-context.ts      pi ExtensionUIContext over elicitation / permission
        ├─ delegation.ts      client fs + terminal backed pi tools
        ├─ mcp.ts             ACP mcpServers → pi custom tools
        └─ extension-events.ts  pi.events → extension_event
   ▼
@earendil-works/pi-coding-agent (sessions, models, tools, extensions, skills, compaction, …)
```

`docs/metadata.md` is the registry of every `_meta` field the adapter reads or emits.

## Development

```bash
npm install
npm run typecheck
npm test            # unit + in-process e2e with a faux model (no network)
npm run build
node dist/bin.js --help
```

## License

Apache-2.0.
