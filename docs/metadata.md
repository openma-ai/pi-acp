# ACP `_meta` registry

This file is the source of truth for every `_meta` field `@openma/pi-acp`
reads or emits. Standard ACP fields are always sufficient; every block below is
optional and clients must ignore what they do not understand.

Adapter-owned keys live under `_meta.pi`. Keys outside that namespace keep
the spelling of the external contract they implement (`terminal_output`,
`terminal_info`, `terminal_exit`, `terminal-auth`, `api-key`, `steering`).

## Initialization and capability negotiation

The adapter reads these paths from `initialize.params.clientCapabilities`:

| Path                                               | Type           | Effect                                                                                                                        |
| -------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `clientCapabilities._meta.terminal_output`         | literal `true` | Shell tool calls carry a display terminal (`terminal_info`/`terminal_output`/`terminal_exit`). Codex/Zed extension.           |
| `clientCapabilities._meta["terminal-auth"]`        | literal `true` | Adds Zed's `_meta["terminal-auth"]` launch spec to the terminal auth method.                                                  |
| `clientCapabilities._meta.terminal_output_delta`   | literal `true` | Same as `terminal_output` with the streaming key spelled `terminal_output_delta` (newer Codex convention).                    |
| `clientCapabilities.elicitation.url`               | object         | OAuth logins open the browser URL through `elicitation/create` `mode: "url"`; `oauth:<provider>` auth methods are advertised. |
| `clientCapabilities.session.configOptions.boolean` | object         | `auto_compaction` is a `boolean` option; without it, a `select` with `on`/`off`.                                              |
| `clientCapabilities.fs.readTextFile`               | `true`         | pi's `read`/`edit` read through `fs/read_text_file` (unsaved editor buffers).                                                 |
| `clientCapabilities.fs.writeTextFile`              | `true`         | pi's `edit`/`write` write through `fs/write_text_file`.                                                                       |
| `clientCapabilities.terminal`                      | `true`         | pi's `bash` runs in a client terminal (`terminal/create`, streamed by the client).                                            |
| `clientCapabilities.elicitation.form`              | object         | Extension dialogs (`select`/`confirm`/`input`/`editor`) become `elicitation/create` forms.                                    |

The initialize response carries:

```json
{
  "_meta": { "steering": { "supported": true } },
  "agentCapabilities": {
    "_meta": {
      "pi": {
        "version": "0.1.0",
        "delegation": { "readTextFile": false, "writeTextFile": false, "terminal": false }
      }
    }
  }
}
```

`delegation` reports which client capabilities the adapter actually wired
(`--no-delegation` forces all three to `false`).

`agentCapabilities._meta.authStatus: {}` announces that the agent pushes the
`_auth/status_update` notification (see below).

## Authentication metadata

| Method               | Advertised metadata                                                                                   | Meaning                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pi-terminal-login`  | `_meta["terminal-auth"] = { command, args, label }` (only when the client advertised `terminal-auth`) | Launch `openma-pi-acp --terminal-login`, which runs pi interactively.                                            |
| `api-key:<provider>` | `_meta["api-key"].provider: string`                                                                   | Provide an API key for one pi provider.                                                                          |
| `oauth:<provider>`   | `_meta.pi.oauth: { provider, subscription }`                                                          | Run pi's provider OAuth flow over elicitation. Advertised only when the client supports URL or form elicitation. |

An `authenticate` request for an API key:

```json
{ "methodId": "api-key:anthropic", "_meta": { "api-key": { "apiKey": "<secret>", "provider": "anthropic" } } }
```

The key is stored through pi's own credential store (`~/.pi/agent/auth.json`),
so the `pi` CLI sees it too. Request metadata contains secrets and must not be
logged or persisted as transcript content.

## Session responses

`session/new`, `session/load`, `session/resume`, and `session/fork` responses carry:

```json
{
  "_meta": {
    "pi": { "sessionFile": "/Users/me/.pi/agent/sessions/…/….jsonl", "diagnostics": ["warning: …"] }
  }
}
```

`diagnostics` lists non-fatal startup problems (extension load errors, untrusted
project resources, unavailable MCP servers).

## Session update metadata

### Message boundaries

Every assistant message ends with a metadata-only empty `agent_message_chunk`:

```json
{
  "sessionUpdate": "agent_message_chunk",
  "content": { "type": "text", "text": "" },
  "messageId": "m3",
  "_meta": {
    "pi": { "event": "assistant_message", "stopReason": "stop", "model": "anthropic/claude-opus-4-5" }
  }
}
```

`messageId` is stable for every chunk of one assistant message (`m<n>` live,
`h<n>` in history replay). History replay only emits the boundary for
`error`/`aborted` messages, adding `error` when pi recorded one.

### Notices carried as `session_info_update`

`_meta.pi.event` discriminates metadata-only facts with no dedicated ACP update:

| Event             | Fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto_retry`      | `phase: "start" \| "end"`, `attempt`, `maxAttempts?`, `delayMs?`, `success?`, `error?`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `queue`           | `steering: string[]`, `followUp: string[]` — pi's pending queued messages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `status`          | `key`, `text` — an extension's status-bar text (`ctx.ui.setStatus`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `widget`          | `key`, `lines: string[] \| null`, `placement`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `editor_text`     | `text` — an extension asked to fill the editor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `extension_error` | `extensionPath`, `hook`, `error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `prompt_usage`    | `usage` (ACP `Usage`) — aggregate restored by history replay                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `custom_message`  | `customType`, `display`, `preview` — a pi custom message entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `branch_summary`  | `fromId`, `summary`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `file_changes`    | `files: [{ path, kind: "add" \| "update", added, removed }]` — files edited during the turn, emitted once when the turn settles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `failure`         | `kind: "auth_required" \| "rate_limited" \| "context_overflow" \| "network" \| "provider_error" \| "cancelled" \| "unknown"`, `message` — emitted before a failed `session/prompt` rejects; the error's `data.pi.failure` carries the same kind                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `extension_event` | One `pi.events.emit` from any extension. `channel`, `namespace` (before the first `:`/`.`, else `pi`), `name`, `payload` (JSON-safe, ≤ 8 KB), `truncated`, `inferred: true`, and two **inferences**: `phase?` (`started` \| `update` \| `completed` \| `failed` \| `cancelled` \| `request` \| `response`, from the channel's trailing token) and `correlationId?` (first of `id`/`runId`/`taskId`/`jobId`/`childId`/`requestId`/`asyncId`/`workflowId`/`sessionId`/`pid`). The adapter does not know what the event means; clients may group by `namespace`+`correlationId` and track `phase` as a work-item lifecycle, treating a missing terminal phase as unknown. |

A retry start also emits a visible italic `agent_message_chunk` with
`_meta.pi.notice: "auto_retry"`; extension `notify()` calls emit a chunk with
`_meta.pi.notify: { level, message }`.

### Compaction

`compaction_update` carries `_meta.pi.reason` (`manual` / `threshold` /
`overflow`) and `tokensBefore` on completion.

### Diff metadata

Every `diff` content block on `edit`/`write` tool results carries:

```json
{
  "type": "diff",
  "path": "/abs/file",
  "oldText": "…",
  "newText": "…",
  "_meta": { "pi": { "fileChange": "update", "diffStats": { "added": 2, "removed": 1 } } }
}
```

`fileChange` is `add` (file did not exist) or `update`; `diffStats` counts lines
as a multiset (a moved line is one removal plus one addition).

### Display terminal metadata

The streaming key is `terminal_output` or `terminal_output_delta`, matching what
the client advertised.

Emitted only when the client advertised `_meta.terminal_output` and the command
is not delegated to a client terminal:

| Block                   | Update                       | Shape                                      |
| ----------------------- | ---------------------------- | ------------------------------------------ |
| `_meta.terminal_info`   | initial `tool_call`          | `{ terminal_id, cwd }`                     |
| `_meta.terminal_output` | streaming `tool_call_update` | `{ terminal_id, data }`                    |
| `_meta.terminal_exit`   | final `tool_call_update`     | `{ terminal_id, exit_code, signal: null }` |

## Command metadata

Entries in `available_commands_update` carry provenance:

```json
{ "name": "deploy", "description": "…", "_meta": { "pi": { "source": "prompt", "path": "/…/deploy.md" } } }
```

`source` is `extension`, `prompt`, or `skill`. Built-ins that change session
state (`/mode`, `/model`, `/thinking`, `/autocompact`) carry the Codex-style
display hint `_meta.commandAction = { kind: "setConfigOption", configId, presentation: "state" }`
so clients can render them as state controls and refresh config options after use.

## Elicitation metadata

Forms generated for pi extension dialogs include the original request:

```json
{ "_meta": { "pi": { "ui": "select", "title": "Pick a branch", "options": ["main", "dev"] } } }
```

`ui` is `select`, `confirm`, `input`, or `editor`. The standard form schema is
complete on its own.

## Extension methods

| Method              | Params                                                                              | Result                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `_session/steering` | `{ sessionId, prompt, _meta?: { steering?: { idleBehavior?: "promptRequired" } } }` | `{ outcome: "injected" }` or `{ outcome: "promptRequired", reason: "noRunningTurn" }`                                           |
| `_pi/trust_project` | `{ sessionId, remember?: boolean }`                                                 | `{ trusted: true }` — loads the project's `.pi/` resources                                                                      |
| `session/set_model` | `{ sessionId, modelId }`                                                            | `{}` — legacy alias for the `model` config option                                                                               |
| `_pi/emit_event`    | `{ sessionId, channel, data? }`                                                     | `{}` — publishes on the session's extension event bus (the reverse of `extension_event`; the injected event is not echoed back) |

`_session/steering` never starts a detached turn: when idle the client sends an
ordinary `session/prompt`.
