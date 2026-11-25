# Design note: Codex job adapter API-key auth on app-server (P6)

- **Status:** Implemented
- **Date:** 2026-10-16
- **Backlog:** `p6-codex-apikey-fix`
- **Builds on:** [p3-adapter-claude-codex.md](p3-adapter-claude-codex.md) §2 (Codex adapter), ADR-0014 (auth modes
  `secret-ref` / `local-login`), p5-ops-chat-next (the assistant engine found the gap first and worked around it).
- **Evidence:** [docs/compat/codex.md](../compat/codex.md) §4.1.

## 1. Problem

The Codex job adapter injects the worker's API key as `CODEX_API_KEY` (or `OPENAI_API_KEY`) into
`codex app-server` and expected Codex to use it, as `codex exec` and the SDK do. Verified on the pinned 0.162.1 with
a local fake Responses API under a localhost-only sandbox: the app-server ignores both variables. With the built-in
`openai` provider, `account/read` reports `requiresOpenaiAuth: true` and every model request goes out **without** an
`Authorization` header. In production that is an unauthenticated request to api.openai.com and a failed job.

## 2. Decision

One shared helper in `packages/agent-adapters/src/runtimes/codex/config.ts`, used by the job adapter
(`appServerArgs`) and the assistant engine (`codexAssistantArgs`), with no duplicate copy:

- `codexApiKeyEnv(secretNames)`: the injected key variable, `CODEX_API_KEY` before `OPENAI_API_KEY`.
- `codexApiKeyProviderArgs(env, apiBaseUrl?)`: `-c model_providers.remyral-openai={ name, base_url, env_key = "<env>",
  wire_api = "responses" }` and `-c model_provider="remyral-openai"`. The variable name and URL are validated: the name
  must be `[A-Z][A-Z0-9_]*`, the URL must be http(s) with no whitespace, and the value is TOML-escaped by `tomlString`.

`appServerArgs` adds the entry only for `secret-ref` and only when a key variable is injected. `local-login`
(subscription / ChatGPT login) and key-less secret-ref sessions keep Codex's own provider, so they behave as before.

**Fail closed:** after `thread/start` / `thread/resume`, a keyed session whose thread reports any provider other than
`remyral-openai` is refused with `InvalidSpawnContextError`. This stops the session from silently running
unauthenticated if a future Codex ignores the override. The usage `provider` stays `openai`, so usage grouping does
not change. `CodexAdapterOptions.apiBaseUrl` defaults to `https://api.openai.com/v1`. It exists for
OpenAI-compatible gateways and tests, and the worker registry does not set it.

## 3. Secret handling

The key is only in the app-server process environment, which is the one place Codex reads it. It is not in argv:
only the variable name appears there. It is not in the tool-command environment
(`shell_environment_policy.exclude`). It is not in the private `CODEX_HOME`: that directory is 0700, holds no
`auth.json` (ephemeral store), was grepped file by file by the test, and is removed on cleanup. It is also not in
events or logs, which are redacted. See the table in compat §4.1.

## 4. Tests

- `test/runtimes/codex/adapter.test.ts`: argv builder (entry, precedence, gateway URL, rejected URLs,
  local-login and key-less sessions unchanged); fake app-server honours `-c model_provider`; fail-closed when the
  override is stripped; usage provider `openai`.
- `test/runtimes/codex/apikey-real.test.ts`: real pinned binary and `mock-responses.ts`, with `CODEX_API_KEY` and
  `OPENAI_API_KEY`. Every request carries `Bearer <key>`. The key is absent from argv, `CODEX_HOME`, the workspace
  and events. The app-server runs under `localhostOnlyConfiner` (macOS Seatbelt, outbound network to localhost only),
  so no test can reach api.openai.com. A negative control without the entry fails with the fail-closed error.
- `smoke.test.ts`: its credential-free spawn now also runs under the localhost-only profile.

## 5. Rollout and rollback

This change touches only the worker. It has no migration, no protocol change and no master change, and it needs a
**worker release**. To roll back, release the previous worker. API-key Codex jobs then fail as before, and
subscription jobs are unaffected either way.

## 6. Residual (UNVERIFIED)

- Linux and Windows runs of the real-binary test. The network guard is macOS-only, so the test is skipped elsewhere.
- A real OpenAI key end to end.
- Codex features tied to the built-in `openai` provider id. For example, the custom entry uses HTTP SSE, not the
  Responses websocket.
