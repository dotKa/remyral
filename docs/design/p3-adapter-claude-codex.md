# Design note: p3-adapter-claude-code, p3-adapter-codex

- **Tasks:** `p3-adapter-claude-code`, `p3-adapter-codex`
- **Package:** `packages/agent-adapters` (`src/runtimes/claude-code/`, `src/runtimes/codex/`, shared helpers in
  `src/runtimes/session-kit/`)
- **Date:** 2026-10-13
- **Inputs (binding):** ADR-0007, ADR-0008, ADR-0010, ADR-0012, ADR-0014, docs/compat/claude-code.md,
  docs/compat/codex.md, docs/compat/handson-2026-10-13.md, docs/design/p3-adapter-contract.md, p3-sandbox,
  p6-cost
- **Pins:** `@anthropic-ai/claude-agent-sdk@0.3.296` (bundles Claude Code CLI 2.1.296), `@openai/codex@0.162.1`
- **Public API:** `createClaudeCodeAdapter(opts)`, `createCodexAdapter(opts)` from `@remyral/agent-adapters`

## 1. Claude Code adapter

### 1.1 Surface and process ownership

ADR-0012: Agent SDK `query()` in-process with **streaming input** (`InputQueue<SDKUserMessage>`). Every API
used was checked against the installed `sdk.d.ts` of 0.3.296 (and the doc pages via Context7).

The SDK spawns the CLI itself. The SDK option `spawnClaudeCodeProcess(options): SpawnedProcess` is
**synchronous**, while our `ProcessConfiner.confine()` is async, so the adapter hands the SDK a
`DeferredOwnedProcess`: pass-through stdin/stdout streams that are wired to the real child once
`spawnOwnedProcess({ command, args, env, secretEnv, confiner })` has started it. Consequences:

- the CLI and its descendants run as a worker-owned process group (POSIX) and start confined (ADR-0007);
- the binary is always the one bundled with the pinned SDK, resolved like the SDK does
  (`@anthropic-ai/claude-agent-sdk-<os>-<arch>[-musl]/claude`) and passed explicitly as
  `pathToClaudeCodeExecutable`, so a global `claude` is never used;
- `kill()` from the SDK = graceful tree signal → grace → tree kill; the SDK's forwarded `signal` (fires after
  its stdin-EOF grace) also ends in a tree kill; `cleanup()` always reaps the group.

### 1.2 Options (all explicit, `buildClaudeQueryOptions`)

| Option | Value | Why |
| --- | --- | --- |
| `settingSources` | `[]` | no user/project/local settings, no repo `.claude/settings.json`, no CLAUDE.md auto-load |
| `permissionMode` | `default` (ask-all, ask-sensitive) / `dontAsk` (deny-sensitive) | never `auto`, `acceptEdits`, `bypassPermissions` |
| `allowDangerouslySkipPermissions` | `false` | |
| `settings`, `managedSettings` | `{ permissions: { disableBypassPermissionsMode: 'disable' } }` | flag + policy layer |
| `permissionPrompts` / `canUseTool` | `'host'` / our approval bridge | |
| `strictMcpConfig`, `mcpServers`, `plugins` | `true`, `{}`, `[]` | no repo MCP servers or plugins |
| `verbatimPrompts` | `true` | job prompts are not expanded (`@path`, slash commands) |
| `env` | allowlisted worker env + `CLAUDE_AGENT_SDK_CLIENT_APP` (+ `CLAUDE_CONFIG_DIR` in secret-ref) | secrets are **not** in options; the spawner adds them to the child env only |
| `sandbox` | `claudeRuntimeSandbox()` only for `sandboxProfile: runtime-sandbox` | mirror of p3-sandbox `claudeSandboxSettings` (packages must not import apps); compile-time checked against the SDK `SandboxSettings` |
| `sessionId` / `resume` | caller UUID / previous session id | resume on the same worker |

Verified on the real 2.1.296 binary without login (smoke test): a repo `.claude/settings.json` with
`defaultMode: acceptEdits` **does** change the mode when project settings load (negative control), and the
hardened options keep `default` against `acceptEdits` and `bypassPermissions`. Finding: `settingSources: []`
**without** an explicit `permissionMode` starts in `auto` (model-classifier approvals) — the explicit mode is
required, not cosmetic. Additionally the adapter fails closed at runtime: if the `system/init` message reports a
permission mode other than the requested one, the session is aborted (`permission_mode_mismatch`).

### 1.3 Session lifecycle

`spawn` starts the query and waits for `initializationResult()` (no model call; works logged out) within
`startupMs`, checking `claude_code_version`. `sendPrompt` pushes to the input stream; a second prompt while the
turn runs requires `interactive_prompt` and is queued by the CLI. On a `result` with `queued_turn_count` 0 the
input is ended, the CLI exits and the stream ends → `status: stopped` with outcome from the last result
(`succeeded` | `failed` with `terminal_reason`/subtype) or `runtime_crashed` when the stream throws/ends without a
result. `maxDurationMs` → cancel, outcome `failed` / `max_duration_exceeded`.

**Cancel:** deny pending approvals → end input → `interrupt()` (bounded by `cancelGraceMs`) → wait for the CLI to
exit within the grace → otherwise `close()`, abort, tree kill, wait for exit up to `cancelMs` →
`CancelTimeoutError` if the leader survives. The tree is reaped in every path before `stopped` is emitted.

**Resume:** same worker only; a new `query({ resume: <session id> })` reusing the previous session's
`CLAUDE_CONFIG_DIR` (ref-counted, removed when the last session using it is cleaned up).

### 1.4 Events, usage and cost

| SDKMessage | AgentEvent |
| --- | --- |
| `assistant` text block (main thread) | `message` (assistant) |
| `assistant` `tool_use` / `server_tool_use` | `tool_call` (input summarised, ≤2 KiB) |
| `user` `tool_result` | `tool_result` (`ok = !is_error`) |
| `result` | `usage` per model (increments) + `error` for error subtypes / `is_error` |
| `assistant.error`, `auth_status.error` | `error` |
| `system/init` | none (session id, model, permission mode recorded) |

All text is redacted against the injected secrets and size-bounded. `modelUsage`/`total_cost_usd` are cumulative
per `query()` (sdk.d.ts doc comments) — the mapper diffs per model and emits **increments**: `inputTokens`,
`outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `model` (canonical), `provider` (`firstParty` → `anthropic`,
…), `authMode`; per-turn `turns` (`num_turns`) and `durationMs` on the first event of a result. Dollar cost:
`secret-ref` → `costUsd` delta with provenance `reported-by-runtime`; `local-login` → **no** `costUsd`,
provenance `estimated-from-tokens` (ADR-0014 rule 5, p6-cost "subscription" class). `getCost` follows the same
rule and returns `unknown` while `cost_reporting` is not offered.

### 1.5 Approvals

`canUseTool(toolName, input, { signal, toolUseID, title })` → `approval_request { approvalId: toolUseID, action:
toolName, description: title or summarised input, risk }` + `status: waiting_approval`, then awaits
`requestApproval` through `ApprovalBroker`. Fail-closed: timeout (`approvalMs`), abort, cancel and session end all
deny; `deny-sensitive` denies without asking; if `approval` is not offered (unverified and policy forbids
unverified) the call is denied with an `approval_unavailable` error event. Risk: `Bash`/`mcp__*` high, reads low,
others medium.

### 1.6 Auth (ADR-0014)

`secret-ref`: credentials from `SpawnContext.secretEnv` reach only the CLI child env (never SDK options, argv or
events); per-session `CLAUDE_CONFIG_DIR` under `stateDir` (transcripts removed on cleanup); probe reports
`authenticated` from worker config (`credentialConfigured`). `local-login`: no config-dir override (the CLI finds
the owner's own login through HOME/keychain); provider credential env names are refused; probe runs the runtime's
own `claude auth status --json` and keeps only the `loggedIn` boolean. `CLAUDE_CODE_OAUTH_TOKEN` is refused in
every mode.

### 1.7 Capabilities (truthful, ADR-0008)

On the pin, every capability is `unverified` ("adapter mapping contract-tested against fakes built from the
pinned typings; live run pending") except: `artifacts` `unsupported` (worker git diff), and on darwin-arm64
`cancel` `degraded` (verified: cancel ends the session and kills the real CLI tree; graceful interrupt of a
running turn not verified live). `safe_cancel` stays `unverified` (tool subprocesses that leave the group are
contained only by p3-sandbox). A foreign SDK or CLI version downgrades everything to `unverified` and `spawn`
refuses unless policy allows unverified.

### 1.8 Tests

- **Contract kit** (`test/runtimes/claude-code/contract.test.ts`): against `FakeClaudeSdk`, whose messages are
  typed by the SDK declarations (the compiler rejects shapes the SDK would not produce) and which starts a real
  stand-in CLI process through the adapter's `spawnClaudeCodeProcess` hook — two configurations (secret-ref with
  `allowUnverified`; local-login without).
- **Unit** (`adapter.test.ts`, `event-mapper.test.ts`): hardened options, dontAsk, runtime sandbox, mode
  mismatch abort, auth-mode env policy, secrets only via the spawner (confiner plan), tree reaping (CLI +
  grandchild), graceful/forced cancel, crash, max duration, approvals (approve / timeout / not offered), usage
  increments, provenance, version gate.
- **Real binary, no login** (`smoke.test.ts`): SDK/CLI pin agreement, probe + version gate, local-login status,
  hostile-settings negative control and hardened modes, spawn through our confiner with the real CLI, cancel and
  reaping.
- **Live** (`live.test.ts`, `REMYRAL_LIVE_RUNTIMES=1`): one-prompt repo task (stream, approval, usage, result,
  resume) and mid-tool cancel without orphans, in `secret-ref` (`ANTHROPIC_API_KEY`) and `local-login`
  (`REMYRAL_LIVE_CLAUDE_LOCAL_LOGIN=1`). **Not run** in this task (no credentials).

## 2. Codex adapter

### 2.1 Surface and protocol types

ADR-0012: `codex --no-daemon app-server --listen stdio:// --strict-config -c …`, one app-server process per
session, started with `spawnOwnedProcess` (+ `ProcessConfiner`) and driven over the shared `JsonlTransport`.
`codex exec --json` is **not** implemented: the app-server serves pre-authorised jobs too (`approvalPolicy:
never`), so the fallback adds no capability.

Protocol types are **generated from the pinned binary**: `codex app-server generate-ts --out <dir>` (subcommand
verified on 0.162.1; `generate-json-schema` also exists). `scripts/gen-codex-protocol.mjs`
(`pnpm --filter @remyral/agent-adapters gen:codex-protocol`) checks `codex --version` = 0.162.1, generates,
vendors the import closure of the ~30 types the adapter uses (170 files) into
`src/runtimes/codex/protocol/generated/` (NodeNext `.js` specifiers, header, lint disabled only in the 4 files
that trip strict rules) and records the sha256 of every raw generated file in `manifest.json`; `--check`
(`check:codex-protocol`, also run by the real-binary smoke test) fails on drift. Runtime validation uses Zod
schemas of only the fields the adapter reads (`protocol/schemas.ts`); each carries a compile-time
`Conforms<GeneratedType, Schema>` proof, so a field renamed/retyped after regeneration breaks the build.
Framing verified on the binary: JSON-RPC 2.0 shapes **without** the `"jsonrpc"` member; server requests are
answered with their original id.

### 2.2 Configuration (all verified on 0.162.1, 2026-10-13)

| Setting | Value | Evidence |
| --- | --- | --- |
| `--no-daemon` | never attach to a shared app-server daemon | top-level `--help` |
| `--strict-config` | unknown `-c` keys abort the start (fail closed after a bump) | `-c bogus=1` → "unknown configuration field" |
| `projects={"<workspace>"={trust_level="untrusted"}}` | repo `.codex/config.toml` not loaded | **without** it a hostile repo `network_access = true` turned the thread sandbox to `networkAccess: true`; with it `false` |
| `project_doc_max_bytes=0` (untrusted repos) | repo `AGENTS.md` not injected as instructions | `instructionSources: []` instead of `[<ws>/AGENTS.md]` |
| `history.persistence="none"` | no prompt history file | `config/read` |
| `shell_environment_policy.exclude=[CODEX_API_KEY, OPENAI_API_KEY, CODEX_ACCESS_TOKEN, <secret names>]` | keys not inherited by tool commands | `config/read` |
| `cli_auth_credentials_store="ephemeral"` (secret-ref) | no `auth.json` | `config/read`; smoke test asserts no `auth.json` |
| `thread/start` | `cwd`, `approvalPolicy` (ask-all→`untrusted`, ask-sensitive→`on-request`, deny-sensitive→`never`), `approvalsReviewer: 'user'` (spawn fails otherwise — never `auto_review`/guardian), `sandbox: workspace-write`, `ephemeral: false` (resume) | captured response |
| `turn/start.sandboxPolicy` | `runtime-sandbox` → `workspaceWrite{networkAccess:false, excludeSlashTmp:true}`; `container`/`host-restricted` → `externalSandbox{networkAccess:'restricted'}` | mirror of p3-sandbox `codexSandboxConfig`; nested Seatbelt fails on macOS, bwrap fails under Docker default seccomp (handson finding 1) |

**Auth (ADR-0014).** `secret-ref`: `CODEX_API_KEY` (etc.) from `SpawnContext.secretEnv` into the child env only;
per-session `CODEX_HOME` = `mkdtemp` under `stateDir` (default `~/.cache/remyral/codex`; refused under
`/tmp`/`/var/tmp` on Linux — handson finding 3), removed on cleanup (ref-counted across resume). `local-login`:
no `CODEX_HOME` override (the owner's own, if set in the worker env), provider keys refused, probe = exit code of
the runtime's own `codex login status`.

### 2.3 Session lifecycle, events, approvals

`spawn` = start process → `initialize` → `initialized` → `thread/start` (thread id = `runtimeSessionId`).
`sendPrompt` = `turn/start`; a follow-up while the turn runs = `turn/steer { expectedTurnId }`
(`interactive_prompt`). `turn/completed` ends the session: stdin EOF → exit within the grace → tree kill if
needed; `completed`→succeeded, `failed`→failed (`codex_<CodexErrorInfo>`), `interrupted`→cancelled when we
cancelled. Cancel: deny pending approvals → `turn/interrupt` (bounded by the grace) → EOF → exit or tree kill →
`CancelTimeoutError` if the leader survives `cancelMs`. Resume: new app-server, same `CODEX_HOME`,
`thread/resume`. A stream end without our cancel = `runtime_crashed`; a known notification failing its schema =
`protocol_error` and the session is cancelled (fail closed).

| Notification | AgentEvent |
| --- | --- |
| `item/started` commandExecution / fileChange / mcpToolCall / dynamicToolCall | `tool_call` (`shell`, `apply_patch`, `mcp:<server>/<tool>`, tool) |
| `item/completed` same kinds | `tool_result` (ok = completed and exit 0 / no error) |
| `item/completed` agentMessage | `message` (assistant) |
| `thread/tokenUsage/updated` + `turn/completed` | one `usage` per turn from the running totals: `inputTokens` = input − cached (OpenAI semantics, UNVERIFIED until T6), `cacheReadTokens`, `cacheWriteTokens`, `turns: 1`, `durationMs`, `provider`, `model`, `authMode`, provenance `estimated-from-tokens`, never `costUsd` |
| `turn/diff/updated` | kept (redacted, ≤1 MiB) → `SessionResult.diff` when `artifacts` is offered |
| `error` (`willRetry: false`), failed turn | `error` |

Server requests `item/commandExecution/requestApproval` (risk high), `item/fileChange/requestApproval` (medium;
high with `grantRoot`), `item/permissions/requestApproval` (high; approve grants exactly the requested profile for
the turn, deny grants nothing), legacy `execCommandApproval`/`applyPatchApproval` → `approval_request` →
`ApprovalBroker`. Only a human approve accepts; timeout/policy → `decline` (`denied` legacy), cancel/session end →
`cancel` (`abort`). deny-sensitive never asks; approval not offered → decline + `approval_unavailable`. MCP
elicitations are declined; `item/tool/requestUserInput`, `item/tool/call`, `account/chatgptAuthTokens/refresh`,
`attestation/generate` and unknown methods get JSON-RPC error −32601. `getCost`: tokens only, provenance
`estimated-from-tokens` (the master prices them, ADR-0012 rule 6); `unknown` while `cost_reporting` is not offered.

### 2.4 Capabilities

On the pin everything is `unverified` (live run pending), including `artifacts` and `safe_cancel`; on
darwin-arm64 `cancel` is `degraded` (verified: cancel ends the session and kills the real app-server tree).
Version mismatch → all `unverified`, spawn refused unless policy allows.

### 2.5 Tests

- **Contract kit** (`test/runtimes/codex/contract.test.ts`) against `fake-app-server.ts`: a real child process
  (Node type stripping) whose handshake replays the capture from the pinned binary
  (`test/fixtures/codex/handshake-0.162.1.json`) and whose notifications/server requests are `satisfies`-typed
  against the generated protocol; secret-ref with `allowUnverified` and local-login without.
- **Unit** (`adapter.test.ts`, `protocol.test.ts`): argv/config builders, mappings, secrets via env only +
  confiner plan, `CODEX_HOME` removal, local-login, usage/diff, approvals (accept/timeout/deny-sensitive/not
  offered), steer, graceful cancel + tree reaping, crash, version gate, `/tmp` refusal, captured handshake vs
  schemas, mapper edge cases.
- **Real binary, no credentials** (`smoke.test.ts`, pinned `codex` or `REMYRAL_CODEX_BIN`): protocol drift check,
  probe + `login status`, handshake + `thread/start` in a workspace with hostile `.codex/config.toml` and
  `AGENTS.md` (→ `networkAccess: false`, `instructionSources: []`, reviewer `user`), no `auth.json`, cancel and
  reaping, `CODEX_HOME` removed. `thread/start` makes the app-server open its Responses websocket, refused (401)
  without a key — no prompt is sent.
- **Live** (`live.test.ts`, `REMYRAL_LIVE_RUNTIMES=1` + `CODEX_API_KEY` / `REMYRAL_LIVE_CODEX_LOCAL_LOGIN=1`):
  repo task with stream/approval/usage/diff/result/resume and mid-command cancel. **Not run** (no credentials).

## 3. Security review

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Repo config loosens permissions (Claude `.claude/settings.json`, CLAUDE.md, hooks, MCP) | `settingSources: []`, explicit mode, bypass disabled in flag + policy layer, strict MCP, no plugins, runtime mode check; smoke test with a hostile repo + negative control | Claude still *reads* repo files as data; instructions in them are not authorisation (ADR-0010). |
| Silent `auto` mode | explicit `permissionMode`; init-mode check aborts | — |
| Credential leakage | secrets only in the CLI child env (spawner), never in SDK options/argv/events; allowlisted base env (worker's own `ANTHROPIC_API_KEY` never inherited); redaction of all event text; per-job `CLAUDE_CONFIG_DIR` removed on cleanup | The model's Bash tool inherits the CLI env (key visible to `env` in a tool call); `sandbox.credentials` masking is not enabled (efficacy unverified, compat §10.10) → p3-secrets-worker. |
| Subscription token intermediation (ADR-0014) | `CLAUDE_CODE_OAUTH_TOKEN` refused; local-login never reads or injects credentials, probe keeps one boolean | — |
| Runaway process / orphans | owned process group, tree kill on cancel/cleanup/end, confiner hook | descendants that `setsid` → p3-sandbox; Windows taskkill gap (contract note). |
| Approval bypass | fail-closed broker (timeout/abort/end deny), approvals only from `requestApproval` with `decidedBy`, deny-sensitive never asks | approvals are per tool call; "always allow" suggestions are ignored. |
| Prompt expansion (`@file`, `/command`) from job text | `verbatimPrompts: true` | — |
| Codex repo config / AGENTS.md (ADR-0010) | workspace `trust_level="untrusted"` (verified: hostile `network_access = true` neutralised), `project_doc_max_bytes=0` for untrusted repos, explicit per-turn `sandboxPolicy` + approval policy, `--strict-config` | the model may still read AGENTS.md as a file |
| Codex approvals routed to a model reviewer | `approvalsReviewer: 'user'` on thread and turn; spawn aborts if the server answers otherwise | — |
| Codex credential persistence / leakage | env-only key, `ephemeral` credential store (no `auth.json`, smoke-tested), per-session `CODEX_HOME` deleted on cleanup, history off, keys excluded from tool env, ChatGPT token-refresh requests refused | rollout files under `CODEX_HOME` live until cleanup |
| Codex protocol drift / hostile server output | types generated from the pinned binary + drift check, Zod validation of every consumed message, bounded lines, fail closed on schema violation, unknown server requests refused | app-server is labelled `[experimental]` |
| Shared app-server daemon cross-talk | `--no-daemon`, one process + `CODEX_HOME` per session | — |

## 4. Rollback and operations

Additive code; rollback = revert the commit (no migrations, no protocol change). Metrics to wire in p6-otel:
spawn latency, cancel mode/latency, approval wait time and timeout count, `permission_mode_mismatch` count.

## 5. UNVERIFIED

1. Every model-dependent behaviour (streaming payloads, `canUseTool` held for long, interrupt of a running
   turn, resume, `total_cost_usd` under subscription) — live suite written, not run.
2. Whether `dontAsk` still allows read-only tools in the workspace (deny-sensitive jobs).
3. Tool subprocess reaping after `interrupt()`/`close()` with a real Bash tool (safe_cancel).
4. Linux/Windows/Pi: smoke suites ran on darwin-arm64 only.
5. Codex: everything model-dependent (T2–T7, T9–T14 of compat/codex.md); `inputTokens` including
   `cachedInputTokens`; `thread/resume` after the app-server exited; effects of `trust_level="untrusted"` beyond
   disabling the project config layer. The `exec --json` path is not implemented.
6. Shared contract change: optional `SessionResult.diff` (additive).
