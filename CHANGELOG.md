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
- Auth: terminal login through pi, per-provider API-key methods, `logout`
- `_session/steering` and `_pi/trust_project` extension methods
- Adapter slash commands plus pi prompt templates, skills, and extension commands
