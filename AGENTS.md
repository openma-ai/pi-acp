# Agent notes

## Project shape

- ACP (Agent Client Protocol) server for the pi coding agent, built **in-process**
  on `@earendil-works/pi-coding-agent`'s SDK (`createAgentSessionRuntime`) — no
  `pi --mode rpc` subprocess.
- `src/acp/agent.ts` — ACP protocol methods over a map of live sessions.
- `src/acp/session.ts` — one ACP session ↔ one pi `AgentSessionRuntime`: runtime
  creation, permission gate (inline extension), prompt lifecycle, teardown.
- `src/acp/translate.ts` — pure projection of pi `AgentSessionEvent`s onto
  `session/update`. `src/acp/history.ts` — pure `session/load` replay.
- `src/acp/permissions.ts`, `config-options.ts`, `commands.ts`,
  `builtin-commands.ts`, `ui-context.ts`, `delegation.ts`, `mcp.ts`, `plan-tool.ts`
  — one concern each.
- `docs/metadata.md` is the registry for every `_meta` field; update it with
  any wire change.

## Rules

- stdout is the ACP wire. Diagnostics go through `src/log.ts` (stderr) only.
- Keep pi's packages `external` in the build: sessions, extensions, and the
  credential store must share one module identity with the user's installed pi.
- Prefer a standard ACP field over `_meta`; when `_meta` is needed, namespace it
  under `pi` and document it.
- Translation modules stay pure and synchronous; test them without a runtime.
- E2E tests use the faux model provider (`@earendil-works/pi-ai` `fauxProvider`)
  through the in-memory harness in `test/helpers/harness.ts`; never dial a
  provider in tests.

## Workflow

```bash
npm install
npm run typecheck
npm test
npm run build
npm run format
```

Do not commit or publish unless asked. Patch releases only unless the
maintainer approves a minor bump.
