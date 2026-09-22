# Changelog

## 0.1.1 — 2026-09-22

- Support client-supplied ACP `mcpServers` through Pi's native custom-tool API,
  including stdio and Streamable HTTP project coordination tools. No MCP extension
  or separate configuration file is needed.
- ACP `session/load` and `session/resume` reconnect using current descriptors and credentials;
  an empty descriptor list removes the previous MCP tools. Session teardown and
  failed initialization release MCP connections.
- Follow paginated tool discovery and normalize names for model providers, including
  dots, length limits, and name collisions across servers.
- Preserve structured tool receipts, propagate MCP tool failures, and forward
  cancellation to in-flight calls.
- Cover the MCP lifecycle with real local HTTP/SSE and stdio servers and faux-model
  ACP session tests. Document client integration in the README.

## 0.1.0 — 2026-09-21

First stable release, promoting the validated 0.1.0-beta.0 adapter without runtime changes.

## 0.1.0-beta.0 — 2026-09-20

Initial release: a full-featured ACP adapter for pi, in-process on the pi SDK.

- Streaming text and thinking with stable message ids; assembled-message boundaries
- Tool calls with kinds, titles, locations, structured diffs, images, and display terminals
- Config options: model (grouped by provider), thinking level, auto-compaction
- Usage accounting: `usage_update` per assistant message, `usage` on `session/prompt`
- Compaction lifecycle (`compaction_update`), auto-retry notices, queue state
- Sessions: `session/list`, `session/load` (full replay), `session/resume`, `session/fork`,
  `session/close`, `session/delete`, silent restore after agent restart, titles
- Client delegation: `fs/read_text_file`, `fs/write_text_file`, `terminal/*`
- Extension UI over ACP: form elicitation with permission-request fallback
- Auth: terminal login through pi, per-provider API-key methods, provider OAuth flows over
  URL/form elicitation, `_auth/status_update` pushes, `logout`
- Capability gating: boolean config options → select fallback, `terminal_output` /
  `terminal_output_delta` display terminals
- Diff `diffStats` + add/update kind, per-turn `file_changes` report, typed `failure` notices
- `/skills`, `/rename`; `commandAction` hints on state commands; legacy `session/set_model`
- Bundled `pi-add-dir` backs ACP `additionalDirectories`
- Extension inventory in session responses, `tool_call._meta.pi.extension`, full
  `custom_message` / `custom_entry` payloads live and on replay
- Extension event bus forwarded as `extension_event` (inferred phase + correlation id); `_pi/emit_event`
- `_session/steering` and `_pi/trust_project` extension methods
- Adapter slash commands plus pi prompt templates, skills, and extension commands

Pre-release validation fixes:

- Apply project trust through pi settings without changing other sessions.
- Preserve image reads when filesystem operations are delegated to the client.
- Handle cancellation during terminal creation.
- Execute delegated shell commands with pi's shell configuration and argument vector.
- Keep native pi tool execution; remove adapter permission modes and MCP server mounting.
