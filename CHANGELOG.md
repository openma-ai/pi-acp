# Changelog

## 0.1.0 — unreleased

Initial release: a full-featured ACP adapter for pi, in-process on the pi SDK.

- Streaming text and thinking with stable message ids; assembled-message boundaries
- Tool calls with kinds, titles, locations, structured diffs, images, and display terminals
- Permission modes (`read-only` / `ask` / `full-access`) as ACP session modes with
  `session/request_permission` gating and per-session "always" memory
- Config options: permission mode, model (grouped by provider), thinking level, auto-compaction
- `update_plan` tool → ACP `plan`
- Usage accounting: `usage_update` per assistant message, `usage` on `session/prompt`
- Compaction lifecycle (`compaction_update`), auto-retry notices, queue state
- Sessions: `session/list`, `session/load` (full replay), `session/resume`, `session/fork`,
  `session/close`, `session/delete`, silent restore after agent restart, titles
- MCP servers (stdio + streamable HTTP) mounted as `mcp__<server>__<tool>`
- Client delegation: `fs/read_text_file`, `fs/write_text_file`, `terminal/*`
- Extension UI over ACP: form elicitation with permission-request fallback
- Auth: terminal login through pi, per-provider API-key methods, provider OAuth flows over
  URL/form elicitation, `_auth/status_update` pushes, `logout`
- Capability gating: boolean config options → select fallback, `terminal_output` /
  `terminal_output_delta` display terminals
- Diff `diffStats` + add/update kind, per-turn `file_changes` report, typed `failure` notices
- `/mcp`, `/skills`, `/rename`; `commandAction` hints on state commands; legacy `session/set_model`
- `_session/steering` and `_pi/trust_project` extension methods
- Adapter slash commands plus pi prompt templates, skills, and extension commands
