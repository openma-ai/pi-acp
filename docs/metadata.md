# ACP `_meta` registry

This file is the source of truth for every `_meta` field `@openma/pi-acp`
reads or emits. Standard ACP fields are always sufficient; every block below is
optional and clients must ignore what they do not understand.

Adapter-owned keys live under `_meta.pi`. Keys outside that namespace keep
the spelling of the external contract they implement (`terminal_output`,
`terminal_info`, `terminal_exit`, `terminal-auth`, `api-key`, `steering`).

## Initialization and capability negotiation

The adapter reads these paths from `initialize.params.clientCapabilities`:

| Path                                               | Type           | Effect                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clientCapabilities._meta.terminal_output`         | literal `true` | Shell tool calls carry a display terminal (`terminal_info`/`terminal_output`/`terminal_exit`). Codex/Zed extension.                                                                                                                                                                               |
| `clientCapabilities._meta["terminal-auth"]`        | literal `true` | Adds Zed's `_meta["terminal-auth"]` launch spec to the terminal auth method.                                                                                                                                                                                                                      |
| `clientCapabilities.auth.terminal`                 | `true`         | The `pi-terminal-login` auth method is advertised (with `args`/`env`, no launch spec).                                                                                                                                                                                                            |
| `clientCapabilities.auth._meta.gateway`            | `true`         | The `gateway` auth method is advertised; `authenticate` accepts the `_meta.gateway` submission.                                                                                                                                                                                                   |
| `clientCapabilities._meta.terminal_output_delta`   | literal `true` | Same as `terminal_output` with the streaming key spelled `terminal_output_delta` (newer Codex convention).                                                                                                                                                                                        |
| `clientCapabilities.elicitation.url`               | object         | OAuth logins open the browser URL through `elicitation/create` `mode: "url"`; `oauth:<provider>` auth methods are advertised. It is also the spec path for an api-key login when `_meta["api-key"]` carries no `apiKey`: the agent serves a one-shot key form on `127.0.0.1` and elicits the URL. |
| `clientCapabilities.session.configOptions.boolean` | object         | `auto_compaction` is a `boolean` option; without it, a `select` with `on`/`off`.                                                                                                                                                                                                                  |
| `clientCapabilities.fs.readTextFile`               | `true`         | pi's `read`/`edit` read through `fs/read_text_file` (unsaved editor buffers).                                                                                                                                                                                                                     |
| `clientCapabilities.fs.writeTextFile`              | `true`         | pi's `edit`/`write` write through `fs/write_text_file`.                                                                                                                                                                                                                                           |
| `clientCapabilities.terminal`                      | `true`         | pi's `bash` runs in a client terminal (`terminal/create`, streamed by the client).                                                                                                                                                                                                                |
| `clientCapabilities.elicitation.form`              | object         | Extension dialogs (`select`/`confirm`/`input`/`editor`) become `elicitation/create` forms.                                                                                                                                                                                                        |

The initialize response carries:

```json
{
  "_meta": { "steering": { "supported": true } },
  "agentCapabilities": {
    "sessionCapabilities": { "fork": {} },
    "_meta": {
      "pi": {
        "version": "0.1.0",
        "delegation": { "readTextFile": false, "writeTextFile": false, "terminal": false }
      },
      "authStatus": {},
      "jetbrains": { "air": { "fork": { "version": 1, "inclusive": true } } }
    }
  }
}
```

`delegation` reports which client capabilities the adapter actually wired
(`--no-delegation` forces all three to `false`).

`agentCapabilities._meta.authStatus: {}` announces that the agent pushes the
`_auth/status_update` notification (see below).

`agentCapabilities._meta.jetbrains.air.fork` is `{ "version": 1, "inclusive": true }`.
It is nested under `jetbrains.air`, the same path as the `session/fork` request
meta, and is deep-merged with `pi` and `authStatus`. `version` is the request
extension version. `inclusive: true` means a message fork keeps the selected
assistant message. It is advertised only together with `sessionCapabilities.fork`.
The constant is copied from openma-common (`ACP_INCLUSIVE_FORK_CAPABILITY`).

### Inclusive `session/fork`

`session/fork` with no `_meta.jetbrains.air.fork` copies the whole session.

When that object is present it must be version 1. The new session keeps the
source history from the start through the selected top-level assistant entry,
inclusive. The source session is not modified. A malformed object, an unknown
version, or a point that cannot be matched returns JSON-RPC `-32602` and does
not copy the whole session.

```json
{
  "_meta": {
    "jetbrains": {
      "air": {
        "fork": {
          "version": 1,
          "messageId": "<assistant message id>",
          "messageFingerprint": "sha256:<64 lowercase hex>",
          "messageOccurrence": 1
        }
      }
    }
  }
}
```

| Field                | Required | Rule                                                                                                                                                        |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`            | yes      | Must be `1`. Any other value is `-32602` with `Unsupported jetbrains.air.fork version`.                                                                     |
| `messageId`          | yes      | Trimmed non-empty string. A trailing `:segment:<n>` also matches the id without that suffix.                                                                |
| `messageFingerprint` | no       | `sha256:` plus 64 lowercase hex digits: SHA-256 of the assistant message's UTF-8 text. Thinking and tool output are not included.                           |
| `messageOccurrence`  | no       | Positive safe integer, default `1`. 1-based index among visible assistant messages with that exact text. A single fingerprint match ignores the occurrence. |

Matching looks at completed top-level assistant messages (not subagent session
files). The id is resolved on the compaction-aware visible branch, then on the
full entry tree. If the id hits a message whose fingerprint differs, that hit
is ignored. Otherwise equal fingerprints on the visible branch are used; when
the text is not visible, the full tree is searched so a compacted message can
still be selected. No match is `-32602`:
`Fork point message <messageId> was not found in session <sessionId>`, with
`data.messageId` set.

The cut stops on that assistant entry. Tool-call blocks on it are removed and
later tool results are not copied, so the next prompt is not an unfinished tool
turn. Text and thinking stay. `session/load` on the new session replays through
that assistant message. A running source session contributes only entries
already persisted.

## Authentication metadata

| Method               | Advertised metadata                                                                                                          | Meaning                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-terminal-login`  | `args: ["--terminal-login"]`; `_meta["terminal-auth"] = { command, args, label }` when the client advertised `terminal-auth` | Launch a focused in-process login (provider picker → api-key paste or OAuth device/browser flow); it runs pi's SDK directly and needs no `pi` binary. |
| `api-key:<provider>` | `_meta["api-key"].provider: string`                                                                                          | Provide an API key for one pi provider. Advertised for featured providers and providers with existing credentials.                                    |
| `gateway`            | `_meta.gateway.protocol: "openai-completions"` (only when the client advertised `auth._meta.gateway`)                        | Store a custom OpenAI-compatible provider entry in `models.json` from a `_meta.gateway` submission.                                                   |
| `oauth:<provider>`   | `_meta.pi.oauth: { provider, subscription }`                                                                                 | Run pi's provider OAuth flow over elicitation. Advertised only when the client supports URL or form elicitation.                                      |

An `authenticate` request for an API key:

```json
{ "methodId": "api-key:anthropic", "_meta": { "api-key": { "apiKey": "<secret>", "provider": "anthropic" } } }
```

The key is stored through pi's own credential store (`~/.pi/agent/auth.json`),
so the `pi` CLI sees it too. Request metadata contains secrets and must not be
logged or persisted as transcript content.

An `api-key:<provider>` authenticate without `_meta["api-key"].apiKey` opens the
spec path when `elicitation.url` is available: the agent serves a one-shot key
form on `127.0.0.1`, sends the URL via `elicitation/create` `mode: "url"` with
`_meta.pi.auth = { provider, event: "api_key" }`, and stores the submitted key.
Without an elicitation channel the request fails `-32000` naming the alternatives
(`_meta["api-key"]`, a url-eliciting client, or `pi-terminal-login`).

A `gateway` authenticate:

```json
{
  "methodId": "gateway",
  "_meta": {
    "gateway": {
      "baseUrl": "https://gw.example.com/v1",
      "headers": { "Authorization": "Bearer <key>", "X-Team": "eng" },
      "providerName": "My Gateway",
      "models": [{ "id": "m1" }]
    }
  }
}
```

`baseUrl` must be http(s). `providerName` slugifies into the models.json
provider id (default `gateway`); `Authorization`/`x-api-key` headers become the
provider `apiKey`, other headers pass through, `api` defaults to
`openai-completions`, and `models` may be `[{"id": …}]` or `["id", …]`. The entry
is merged into `models.json` under `providers` and the runtime refreshes.

`authenticate` on `pi-terminal-login` is rejected `-32602`: terminal methods run
out of band, so a client must never send them. The launch spec in
`_meta["terminal-auth"]` re-runs the entry script under `process.execPath` when
`argv[1]` is a `.js/.ts` file (npx/direct invocation), resolves the package's own
`bin` name from its `package.json` (global install), else falls back to the
package bin name — it never hardcodes a launcher.

Every authentication failure (`session/new`, `session/prompt`, `authenticate`)
returns `-32000` whose `data.authMethods` lists the methods the client can act
on. Typing pi's `/login`, `/logout`, or another native auth command in a prompt
ends the turn the same way — the text never reaches the model and credentials
are unchanged.

`authenticate` and `logout` results report the active account:

```json
{
  "_meta": {
    "pi": {
      "auth": { "provider": "anthropic", "kind": "api_key" },
      "authStatus": {
        "kind": "authenticated",
        "providers": [{ "providerId": "anthropic", "name": "Anthropic", "kind": "api_key" }]
      }
    }
  }
}
```

`logout` is scoped, never a wipe-all. `_meta.pi.logout` selects the scope:

```json
{ "_meta": { "pi": { "logout": { "provider": "anthropic" } } } }
{ "_meta": { "pi": { "logout": { "all": true } } } }
```

Omitting `provider`/`all` targets the configured default provider (the active
model's provider, `settings.json` `defaultProvider`, or the single removable
credential); when that is ambiguous the request is `-32602` and names the signed
in providers plus the `{"all": true}` escape. Clearing removes the provider from
pi's credential store, the adapter's runtime keys, and its `apiKey`/auth headers
in `models.json`. The result carries `_meta.pi.logout = { cleared: [providerId…] }`
and the refreshed `authStatus`; `_auth/status_update` is pushed as usual.

## Session responses

`session/new`, `session/load`, `session/resume`, and `session/fork` responses carry:

```json
{
  "_meta": {
    "pi": {
      "sessionFile": "/Users/me/.pi/agent/sessions/…/….jsonl",
      "diagnostics": ["warning: …"],
      "additionalDirectories": ["/abs/other-root"],
      "extensions": [
        {
          "path": "/Users/me/.pi/agent/npm/node_modules/pi-subagents/index.ts",
          "source": "npm:pi-subagents",
          "scope": "user",
          "origin": "package",
          "tools": ["subagent"],
          "commands": ["subagents", "run"],
          "customTypes": ["subagent:result"]
        }
      ]
    }
  }
}
```

`extensions` is the inventory clients use to route per-extension adapters:
`tools` map `tool_call.name` (also attributed live via `tool_call._meta.pi.extension`),
`commands` map slash commands, `customTypes` map `custom_message` /
`custom_entry`. Event-bus traffic (`extension_event`) has no sender identity in
pi; correlate by channel namespace.

`additionalDirectories` echoes the canonical extra roots in filesystem scope for
this session (not including `cwd`). The same active list is the standard
`session/list` `SessionInfo.additionalDirectories` field. `cwd` remains the only
project root for skills and AGENTS.md.

The path boundary is opt-in. It applies to `read`, `write`, `edit`, `grep`,
`find`, `ls`, and `bash` only when the client sent `additionalDirectories`
(including `[]`) or set `_meta.pi.restoreAdditionalDirectories` to `true`.
Omitting the field leaves tool access as it was before this capability: paths
outside `cwd` are not rejected. `additionalDirectoriesEnforced` is `true` when
the boundary is on.

`session/load`, `session/resume`, and `session/fork` follow the stable ACP rule:
omitting `additionalDirectories` activates no additional roots and does not
inherit a previously stored list. An empty array is an explicit cwd-only
boundary. A non-empty array replaces the list and turns the boundary on.
`_meta.pi.restoreAdditionalDirectories: true`, sent without the field, restores
the last explicit list and turns the boundary on. Filesystem roots, `$HOME`,
and malformed entries reject the request. `session/list` reports only the
active list, so it is `[]` after an omit.

`diagnostics` lists non-fatal startup problems (extension load errors, untrusted
project resources, unavailable MCP servers).

## Session update metadata

### Message boundaries

Every assistant message ends with a metadata-only empty `agent_message_chunk`:

```json
{
  "sessionUpdate": "agent_message_chunk",
  "content": { "type": "text", "text": "" },
  "messageId": "8f3a1c2b:1",
  "_meta": {
    "pi": { "event": "assistant_message", "stopReason": "stop", "model": "anthropic/claude-opus-4-5" }
  }
}
```

`messageId` is stable for every chunk of one assistant message, live and in
`session/load` replay, and it does not change when the agent process restarts.
Pi only assigns the assistant entry id when the message is appended, after
streaming, so the id is derived from state that already exists when the first
token is produced: `<parentEntryId>:<ordinal>`. `parentEntryId` is the current
leaf (the user message that triggered the turn, or the previous tool result).
`ordinal` is the 1-based file order of this assistant among assistant children
of that parent. A message with no parent uses `root`. Replay walks the full
entry tree and applies the same rule. `session/fork` accepts this id (and a
trailing `:segment:<n>`) and resolves it to the pi entry. Older counter ids
(`m<n>` live, `h<n>` on replay) are not emitted; fork still accepts them when
`messageFingerprint` identifies the message. History replay only emits the
boundary for `error`/`aborted` messages, adding `error` when pi recorded one.

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
| `custom_message`  | `customType`, `display`, `text`, `content` (full, JSON-safe), `details?` (full, JSON-safe), `truncated`, `entryId?` — an extension `pi.sendMessage(...)`, live and on replay                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `custom_entry`    | `customType`, `data?` (JSON-safe), `truncated`, `entryId?` — an extension `pi.appendEntry(...)`, live and on replay                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
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

### Tool attribution

`tool_call` (initial update) carries `_meta.pi.extension: <path>` when the tool
was registered by a pi extension. Built-in tools and
client-delegated tools carry no attribution. A call another tool made
(`ctx.executeTool`, including codemode scripts that call an MCP tool) also
carries `_meta.pi.parentToolCallId` with the caller's tool-call id. Deferred
MCP tools show up as their own `tool_call` after `tool_search` loads them, with
the same kind, title, raw input, and raw output as any other tool.

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
state (`/model`, `/thinking`, `/autocompact`) carry the Codex-style
display hint `_meta.commandAction = { kind: "setConfigOption", configId, presentation: "state" }`
so clients can render them as state controls and refresh config options after use.

## Elicitation metadata

Forms generated for pi extension dialogs include the original request:

```json
{ "_meta": { "pi": { "ui": "select", "title": "Pick a branch", "options": ["main", "dev"] } } }
```

`ui` is `select`, `confirm`, `input`, or `editor`. The standard form schema is
complete on its own.

## Extensions

User-installed extensions are forwarded as-is. They do not implement ACP
`additionalDirectories`; that scope is enforced by the adapter.

## Extension methods

| Method              | Params                                                                              | Result                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `_session/steering` | `{ sessionId, prompt, _meta?: { steering?: { idleBehavior?: "promptRequired" } } }` | `{ outcome: "injected" }` or `{ outcome: "promptRequired", reason: "noRunningTurn" }`                                           |
| `_pi/trust_project` | `{ sessionId, remember?: boolean }`                                                 | `{ trusted: true }` — loads the project's `.pi/` resources                                                                      |
| `_pi/add_directory` | `{ sessionId, path }`                                                               | `{ additionalDirectories: string[] }` — append one absolute root (max 16), turn the boundary on, and persist it                 |
| `session/set_model` | `{ sessionId, modelId }`                                                            | `{}` — legacy alias for the `model` config option                                                                               |
| `_pi/emit_event`    | `{ sessionId, channel, data? }`                                                     | `{}` — publishes on the session's extension event bus (the reverse of `extension_event`; the injected event is not echoed back) |

`_session/steering` injects into the running turn at the next LLM boundary: after
the current assistant turn finishes its tool calls, before the next model call
(pi's steer, Enter in the editor). It never starts a detached turn. When the
session is idle the result is `promptRequired` and the client sends an ordinary
`session/prompt`. A follow-up that should wait until the turn ends (pi's
Alt+Enter) is that later `session/prompt`.

`session/set_config_option` for `model` and `thinking`, legacy `session/set_model`,
and `/model` / `/thinking` also write pi's global defaults (`defaultProvider`,
`defaultModel`, `defaultThinkingLevel` in `settings.json`), the same as the pi TUI.
