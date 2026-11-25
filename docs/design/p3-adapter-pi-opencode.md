# Design note: p3-adapter-pi / p3-adapter-opencode

- **Tasks:** `p3-adapter-pi` (Pi 1.1.0 over `pi --mode rpc`), `p3-adapter-opencode` (OpenCode 1.19.0 over `opencode serve`)
- **Package:** `packages/agent-adapters/src/runtimes/{common,pi,opencode}` — factories `createPiAdapter(opts)`, `createOpenCodeAdapter(opts)`
- **Date:** 2026-10-13
- **Binding inputs:** docs/compat/{README,pi,opencode,handson-2026-10-13}.md, ADR-0007, ADR-0008, ADR-0010, ADR-0012, ADR-0014,
  docs/design/p3-adapter-contract.md, docs/design/p3-sandbox.md
- **Pins:** `@earendil-works/pi-coding-agent@1.1.0`; `opencode-ai@1.19.0` (server) / `@opencode-ai/sdk@1.19.0` (read for types only, see §6.1)

## 1. Scope

Two real adapters behind the p3 contract, each with: version gate, truthful capabilities, process ownership through the
caller's `ProcessConfiner`, both ADR-0014 auth modes, native→protocol event mapping with gapless sequence numbers and resume
cursors (`SessionEventLog`), approvals, cancel (native interrupt → grace → tree kill), resume where supported, result and cost
with provenance. Out of scope: wiring into `apps/worker` (orchestration-dev swaps the fake for these factories), secret
resolution (`p3-secrets-worker`, the adapters take `SpawnContext.secretEnv`), sandbox selection (`p3-sandbox`).

`runtimes/common` holds what both adapters share: `SessionCore` (lifecycle, protocol-validated `emit`, usage totals, timers),
text redaction/truncation and protocol-identifier mapping, version/command probing, `resolveConfiner`, and the POSIX
descendant process-group sweep (§5.3). Shared change (additive): `startLoopbackServer` accepts an optional `confiner`
forwarded to `spawnOwnedProcess`; `SessionCore.ref` is assignable because OpenCode assigns its session id after spawn.

## 2. Pi adapter

### 2.1 Process and flags (all verified with `pi --help` 1.1.0 and the real binary)

One `pi` process per session, owned through `spawnOwnedProcess` (process group, minimal env, secrets env-only, optional
confiner), cwd = the workspace:

```
pi --mode rpc --offline --no-approve --no-extensions -e <runDir>/remyral-permission-gate.mjs [-e <operator ext>...]
   --no-skills --no-prompt-templates --no-themes --no-mcp [--no-context-files if untrusted]
   --session-dir <stateDir>/transcripts/<uuid> --session-id <uuid> [--provider P] [--model M] [--tools a,b]
env: PI_OFFLINE=1 PI_TELEMETRY=0 REMYRAL_PI_GATE_POLICY=<json> [PI_CODING_AGENT_DIR=<runDir>/agent  (secret-ref only)]
```

- **Readiness:** `spawn` resolves only after a `get_state` round trip whose `sessionId` equals the requested `--session-id`
  (otherwise `RuntimeCrashedError`). Cold start was 1–5 s on the Mac; contract runs use `startupMs` ≥ 10 s.
- **Framing:** `JsonlTransport` (LF-only, U+2028-safe) + `piCodec` (`{id,type}` commands, `response` correlation by id,
  `extension_ui_request` dialogs as runtime→us requests answered with `extension_ui_response`).
- **Schema:** `PiInbound` (Zod, from `rpc-types.d.ts` + `docs/json.md` + `agent-session.d.ts`) is a discriminated union of
  every record type 1.1.0 emits; an unknown type closes the transport and fails the session with
  `runtime_protocol_error` (Pi has no protocol-version handshake — drift must surface, compat/pi.md §3.1).
- **Run end:** `agent_settled` (not `agent_end`) ends the run; the adapter then closes stdin, terminates the tree and emits
  the terminal `status: stopped` only after the tree is gone. A settled run ends the session; a later prompt is `resume`.

### 2.2 Auth modes (ADR-0014)

| Mode | Agent dir | Credentials | `probe().authenticated` |
|---|---|---|---|
| `secret-ref` | fresh `PI_CODING_AGENT_DIR=<runDir>/agent` (0700, empty: no `auth.json`, settings or global extensions of the worker user) | provider key from `SpawnContext.secretEnv` via env only (e.g. `ANTHROPIC_API_KEY`); `--api-key` is never used | `unknown` (keys are injected per job) |
| `local-login` | not set: Pi finds the owner's own login under the worker user's `HOME` | none injected; the adapter never opens Pi's files | `pi auth check --provider P --json --no-refresh` → `ready`=yes, `not_ready`=no, else unknown (no `--credentials`) |

Global resources of the user's agent dir (extensions, skills, prompt templates, themes, MCP) are disabled by flags in both modes.

### 2.3 Permission gate (our extension)

`PI_GATE_SOURCE` is a dependency-free ESM extension written per session into the private run dir (0600) and loaded with
`--no-extensions -e`. It registers one `tool_call` handler: read-only tools (`read, grep, find, ls`) run unless the policy is
`ask-all`; `deny-sensitive` blocks every other tool; otherwise it calls `ctx.ui.select("remyral-approval:v1:{json}",
["approve","deny"], {timeout: approvalMs})`. Only the exact answer `approve` lets the call run. Missing/invalid policy, no UI,
timeout (`undefined`), cancel, deny, or any exception ⇒ `{block:true, reason}`. Pi additionally blocks a tool when a
`tool_call` handler throws (docs/extensions.md). If the `approval` capability is not offered on this platform the adapter
starts the gate in `deny-sensitive` (nobody could answer a dialog). Verified on the real binary: approve runs bash, deny and
a 1.5 s timeout block it with the gate's reason, `deny-sensitive` never asks, a project `.pi/extensions/*.mjs` is not loaded.

## 3. Pi mapping (native → protocol `AgentEvent`)

| Pi 1.1.0 record | Protocol event / action |
|---|---|
| `spawn` (after `get_state`) | `status: starting` |
| first `sendPrompt` → `prompt` command | `message{role:user}` (redacted) + `status: running`; `success:false` → `error{prompt_rejected}` + `stopped` (failed) |
| later `sendPrompt` while running | `message{role:user}` + RPC `steer` (requires `interactive_prompt`) |
| `message_start{assistant}` | remembered for `usage.durationMs` |
| `message_end{assistant}` | `message{assistant, text blocks}` if non-empty; `usage{inputTokens=input, outputTokens=output, cacheReadTokens, cacheWriteTokens, costUsd=cost.total (secret-ref only), turns:1, durationMs, provider, model, authMode}` per response (an increment, never a total); `stopReason:"error"` → `error{model_error}` and outcome `failed` |
| `message_*{user/system/toolResult}`, `message_update` deltas, `turn_*`, `agent_start/end`, `queue_update`, compaction/retry start | not mapped (deltas are aggregated; `message_end` is authoritative) |
| `tool_execution_start` | `tool_call{callId=toIdentifier(toolCallId), toolName, inputSummary=JSON(args) ≤2000}` |
| `tool_execution_end` | `tool_result{callId, ok=!isError, outputSummary=text content ≤2000}` |
| `extension_ui_request{select, title "remyral-approval:v1:…"}` | `approval_request{approvalId=ui id, action:"runtime.dangerous_tool", description:"<tool>: <input>", risk: high for bash/powershell else medium}` + `status: waiting_approval`; `requestApproval` answers `{value:"approve"|"deny"}` and returns to `running` |
| any other dialog (`select/confirm/input/editor`) or unparsable gate title | answered `{cancelled:true}` (fail-closed), no event |
| fire-and-forget UI (`notify`, `setStatus`, …) | ignored |
| `auto_retry_end{success:false}` / `compaction_end{errorMessage}` / `extension_error` | `error{retry_exhausted | compaction_failed | extension_error}` (extension path omitted) |
| `agent_settled{aborted}` | shutdown, then `status: stopped`; outcome `cancelled` if aborted, `failed` after an error stop reason, else `succeeded` |
| process exit not caused by us | `error{runtime_crashed, exit + redacted stderr tail}` + `stopped` (failed) |
| unknown record / oversized line | `error{runtime_protocol_error}` + `stopped` (failed) |
| `maxDurationMs` elapsed | `error{max_duration_exceeded}`, cancel path, outcome `failed` |

Every text passes `redactSecrets` (all `secretEnv` values) and the protocol `Text` bound; every event is validated against
`AgentEvent` before it is appended (`SessionCore.emit`). Result: `collectResult` = outcome, last assistant text (≤4000),
error code, exit. Cost: sum of the usage events — `reported-by-runtime` (Pi's catalogue estimate) under `secret-ref`,
`estimated-from-tokens` without dollars under `local-login` (ADR-0014 rule 5).

## 4. Pi capability decisions (ADR-0008)

`PI_CONTRACT_TESTED = { 'darwin-arm64': '2026-10-13' }` — the real-binary suite (§7) passed there. On every other OS/arch
everything except `artifacts` is `unverified` ("not contract-tested on <os-arch> yet"); a version ≠ 1.1.0 is downgraded by
`applyVersionGate` and refused by `spawn` unless `allowUnverified`.

| Capability | Status (darwin-arm64) | Reason |
|---|---|---|
| streaming | supported | message-level events (token deltas aggregated) |
| interactive_prompt | supported | follow-ups while running = Pi `steer`; a settled run ends the session |
| approval | **degraded** | not native: our gate extension (tool calls only, deny on timeout/error); containment = sandbox |
| cancel | supported | `clear_queue` + `abort`, then process-tree kill after the grace period |
| resume | **degraded** | same worker only: `--session-id` respawn on the transcript kept under `stateDir/transcripts` |
| cost_reporting | **degraded** | Pi's catalogue estimate (secret-ref); tokens only under local-login |
| artifacts | unsupported | no artifact API; the worker collects the git diff |
| safe_cancel | **degraded** | see §5.3 |

## 5. Cancel and process ownership

### 5.1 Pi cancel

`cancel` → state `stopping` (+ event) → pending approvals answered `cancelled` → if a run is active: `clear_queue` then
`abort` (Pi: "abort lets queued messages continue"; `abort` answers once the session is idle), bounded by `cancelGraceMs`
→ shutdown → `stopped` (`cancelled`). `graceful` if the abort completed in the grace period, otherwise `forced`.
`cancelMs` bounds everything: on expiry the tree is killed and `CancelTimeoutError` is thrown. `ctx.signal` abort = cancel.

### 5.2 Shutdown

Snapshot descendant process groups → close stdin (Pi's orderly exit) → `OwnedProcess.terminate`: SIGTERM to Pi's group
(Pi's handler kills its tracked bash groups) → SIGKILL after the grace → SIGKILL every snapshotted group → `dispose()`
(confiner cleanup). The terminal event is emitted afterwards, so `stopped` implies the tree is gone.

### 5.3 Finding: Pi tool processes leave Pi's process group

Pi 1.1.0 spawns every bash tool call with `detached: true` (`dist/core/tools/bash.js`): the tool runs in its **own** process
group. Verified: SIGKILL of Pi's group during `sleep 600 & sleep 601` left both sleeps alive, re-parented to init. Pi's own
paths kill them (`abort` → `killProcessTree(-pid)`; SIGTERM handler → `killTrackedDetachedChildren`), but a hung or
SIGKILLed Pi does not. Mitigation: `snapshotDescendantGroups(pid)` (`ps -A -o pid=,ppid=,pgid=`) before the kill and
`killGroups` after it (unit + real-process test: a detached grandchild survives the group kill and is reaped by the sweep;
real-binary tests: graceful and forced cancel during `sleep N & sleep N+1` leave no process). Residual: a process started
between snapshot and kill, or one that left the tree (double fork / `setsid` / an agent-started daemon whose parent shell
already exited) is reaped only by the sandbox (container teardown, host reaper, p3-sandbox). Hence `safe_cancel: degraded`.

## 6. OpenCode adapter

### 6.1 Server, client, environment (verified against the 1.19.0 binary and its served OpenAPI `/doc`)

One `opencode serve` per session via `startLoopbackServer` (now forwarding the caller's `ProcessConfiner`), cwd = workspace:

```
opencode serve --hostname 127.0.0.1 --port <free port> --pure
env: OPENCODE_SERVER_PASSWORD=<32 random bytes, env only>  OPENCODE_DISABLE_PROJECT_CONFIG=1
     OPENCODE_PERMISSION=<complete map, §6.2>  OPENCODE_CONFIG_CONTENT={autoupdate:false, share:"disabled", plugin:[], model, small_model, +operator config}
     OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_LSP_DOWNLOAD=1 OPENCODE_DISABLE_CLAUDE_CODE=1
     OPENCODE_DB=<stateDir>/storage/<uuid>/db/opencode.db   XDG_CONFIG_HOME/XDG_CACHE_HOME/XDG_STATE_HOME = per-job dirs
     XDG_DATA_HOME = per-job dir (secret-ref) | the worker user's (local-login: OpenCode finds its own auth.json)
```

All `OPENCODE_*` names above are in the CLI env table of the docs except `OPENCODE_DB` and `OPENCODE_DISABLE_PROJECT_CONFIG`
(present in the binary; effects verified locally: custom DB path persists sessions across restarts — the directory must
exist; project config ignored by the v1 config loader). `OPENCODE_SERVER_USERNAME`, `OPENCODE_CONFIG(_DIR)`,
`OPENCODE_AUTO_SHARE` and any operator-supplied `OPENCODE_PERMISSION`/`_CONFIG_CONTENT`/`_DB` are stripped.

Start sequence (each step fail-closed): authenticated readiness on `/global/health` → **anonymous `GET /session` must be
401** (`UnsafeServerError` otherwise; real-binary test: the same binary started without its password is refused) →
`/global/health.version` must equal the probed version → `GET /config` effective `permission` must equal our map
(`permissionDrift`) → `/event` SSE connected (`server.connected`) → `POST /session {title, permission: ruleset}` (or
`GET /session/{id}` on resume) → the session's `directory` must realpath-equal the workspace.

The HTTP client is our own (`OpenCodeClient`) with a **route allowlist** — health, config (GET), session create/get,
`prompt_async`, abort, messages, diff, `/permission/{id}/reply`, `/question/{id}/reject` — and id-format checks on every
path parameter; PTY, shell, auth, config PATCH, upgrade, MCP and worktree routes are unreachable through it. The SDK is not
used: its v1 client types predate the 1.19.0 server (`permission.updated` vs the served `permission.asked`) and it has no
allowlist. SSE frames are `data:`-only JSON (`{id,type,properties}`), parsed with a bounded frame size.

### 6.2 Permission policy (our policy beats repo policy)

Every `PermissionConfig` key of the served schema is set (OpenCode defaults are permissive): `read/glob/grep/list` allow
(ask under `ask-all`), `edit/bash/webfetch/websearch` ask (deny under `deny-sensitive`), `todowrite` allow,
`external_directory/task/question/lsp/doom_loop/skill` always deny. The same decisions are sent as the session ruleset,
starting with `{permission:"*", pattern:"*", action: ask|deny}` (last match wins) for tools we do not know. If the `approval`
capability is not offered on the platform, every `ask` becomes `deny`. A policy watch re-reads `GET /config` every 5 s while
a run is active and stops the job on drift.

### 6.3 Mapping (OpenCode `/event` → protocol)

| OpenCode 1.19.0 | Protocol event / action |
|---|---|
| `spawn` | `status: starting` |
| first `sendPrompt` → `prompt_async {parts:[{type:text}], model}` (204) | `message{user}` + `status: running`; HTTP error → `error{prompt_rejected}` + `stopped` (failed) |
| later `sendPrompt` while running | `message{user}` + `prompt_async` (verified: the queued message joins the next model request of the running loop) |
| `message.updated{assistant}` | remembers provider/model for usage |
| `message.part.updated` step-start / step-finish | `usage{inputTokens=input, outputTokens=output+reasoning, cacheRead/WriteTokens, costUsd=part.cost (secret-ref only), turns:1, durationMs, provider, model, authMode}` once per step part |
| part `tool` (first non-pending state) | `tool_call{callId=toIdentifier(callID), toolName, inputSummary}` once per call |
| part `tool` `completed` / `error` | `tool_result{ok, output|error ≤2000}` once per call |
| part `text` with `time.end` (not synthetic) | `message{assistant}` once per part |
| `permission.asked` | `approval_request{approvalId=per id, action:"runtime.dangerous_tool", description:"<permission>: <command or patterns>", risk high for bash/edit/external_directory}` + `waiting_approval`; `requestApproval` → `/permission/{id}/reply {reply: once|reject}` (never `always`); no decision within `approvalMs` → `reject` |
| `permission.replied` not sent by the adapter (or with another reply) | `error{approval_bypass_detected}`, cancel, outcome failed |
| `pty.created`, `session.created` of another session, policy drift during the run | same (tamper signals, §8) |
| `question.asked` | `/question/{id}/reject` (no channel; `question` is denied anyway) |
| `session.error` | `error{<snake_case error name>}` (e.g. `provider_auth_error`); `MessageAbortedError` ignored during our cancel |
| `session.status idle` / `session.idle` after busy | shutdown, then `status: stopped` (failed if a session error was seen) |
| `/event` ends while the server lives | `error{event_stream_lost}` + `stopped` (failed): no silent event loss |
| server exit not caused by us | `error{runtime_crashed}` + `stopped` (failed) |
| consumed event / part with an invalid shape | `error{runtime_protocol_error}` + `stopped` (failed); unconsumed event types (plugin, catalog, lsp, …) are ignored |

### 6.4 Capabilities (OpenCode 1.19.0, darwin-arm64 contract-tested 2026-10-13; elsewhere `unverified`)

| Capability | Status | Reason |
|---|---|---|
| streaming | supported | part-level events (text deltas aggregated per finished part) |
| interactive_prompt | supported | `prompt_async` while busy; delivered with the next model request |
| approval | **degraded** | native ask/reply, but tool shells inherit the server password (verified) and could answer themselves — detected and failed, not prevented |
| cancel | supported | `/session/{id}/abort` → wait for idle within grace → tree kill |
| resume | **degraded** | same worker: per-session `OPENCODE_DB` + index file; re-prompted after a server restart (verified) |
| cost_reporting | **degraded** | per-step price-table estimate (secret-ref); tokens only under local-login |
| artifacts | unsupported | the adapter exports none; the worker collects the git diff |
| safe_cancel | **degraded** | abort kills the running bash; tool shells run in their own process group (verified: they survive a SIGKILL of the server) ⇒ same descendant sweep as Pi |

### 6.5 Findings on the pinned binary

1. **Project plugins load despite `OPENCODE_DISABLE_PROJECT_CONFIG`.** The v2 configuration service
   (`@opencode/v2/Config`) walks up from the session directory collecting `.opencode/` directories and `opencode.json(c)`
   files without consulting the flag (the v1 loader does consult it); its `config-plugin` imports
   `.opencode/{plugin,plugins}/*.{ts,js}` into the server process. Verified: a workspace with
   `.opencode/plugin/evil.js` wrote a marker file during the first prompt, with the flag set and `--pure`. Impact: repository
   code runs in the server (password and provider keys in its env) before any approval. **Mitigation:**
   `findOpenCodeProjectConfig` — the adapter refuses (`InvalidSpawnContextError`) any workspace that has `.opencode`,
   `opencode.json` or `opencode.jsonc` in it or an ancestor (except directly in the worker user's home, which OpenCode loads
   unconditionally and which belongs to the operator). Checked again on `resume`. To report upstream.
2. **Tool shells inherit `OPENCODE_SERVER_PASSWORD`** (verified: `env | grep -c` → 1; upstream PR #32707 unmerged). An
   approved bash call can call the job server's API (self-approve, PATCH config, PTY). Mitigations: approval descriptions
   show the command; tamper detection (foreign `permission.replied`, `pty.created`, foreign `session.created`, policy drift
   poll) fails the job; the sandbox should forbid tool processes from connecting to the server port (p3-sandbox follow-up).
3. **Early requests can hang:** a request that reaches the port during start-up never completes (observed once); the
   readiness poll uses per-attempt timeouts. Cold start was 5–16 s on the Mac; contract runs use `startupMs` 60 s.
4. Bash tools run under the worker's `$SHELL` (zsh on the Mac) in their own process group; abort kills them.

## 7. Tests

| Suite | Runs | What |
|---|---|---|
| `pi-units.test.ts` | always | 7 transcripts recorded from the real 1.1.0 binary (scripted provider) validate against `PiInbound` and map to the expected events; codec; the generated gate source executed with a fake ExtensionAPI (no policy, approve, deny, timeout, throw, no UI, ask-all, deny-sensitive, MCP-style names); capability table; descendant sweep (parser + real detached grandchild) |
| `pi-adapter.test.ts` | always | contract kit ×3 against `fixtures/pi/fake-pi.mjs` (replays the recorded shapes, executes the real gate file): tested platform, untested platform (all unverified), version drift with `allowUnverified`; plus flags/argv (no secret), trusted vs untrusted, version gate, missing binary, wrong session id, prompt rejection, crash, unknown record, forced cancel, gate in deny mode when approval is not offered, wall-clock limit, auth-mode dirs, local-login token-only usage |
| `pi-real.test.ts` | `REMYRAL_PI_BIN=<pinned pi>` | contract kit + smoke against the **real** binary with `fixtures/pi/faux-provider.mjs` (Pi's own `fauxProvider`; no network, no credentials): probe, handshake + idle abort, approve/deny/timeout/deny-sensitive, graceful and forced cancel during bash with process check, untrusted repo (`AGENTS.md` canary absent from the system prompt, project `.pi` extension not executed; trusted loads `AGENTS.md`), resume continues the transcript, usage fields, secret redaction |
| `pi-live.test.ts` | `REMYRAL_LIVE_RUNTIMES=1` + `REMYRAL_PI_BIN` (+ model, auth) | **needs the owner's login or an API key**: one-prompt repository edit with approvals (stream, usage, result, file changed) and a live cancel |
| `opencode-units.test.ts` | always | 4 `/event` transcripts recorded from the real 1.19.0 server (scripted provider) map to the expected events (dedupe, usage per step, approvals, abort); session filter, tamper signals, invalid consumed events; permission policy per approval policy + drift; route allowlist (path-injection ids refused); SSE parser (LF/CRLF, multi-line data, comments); capabilities; workspace guard |
| `opencode-adapter.test.ts` | always | contract kit ×3 against `fixtures/opencode/fake-opencode.mjs` (serves the recorded shapes with Basic auth): tested platform, untested platform, version drift; plus server env/argv (password env-only, complete permission, private dirs, operator override stripped), local-login data dir, project-config refusal before start, fail-open server refused, effective-permission drift refused, version gate, crash, invalid event, foreign permission reply, permission change mid-run, forced cancel, approval not offered ⇒ reject, follow-up delivery, resume + unknown session, usage per auth mode |
| `opencode-real.test.ts` | `REMYRAL_OPENCODE_BIN=<pinned binary>` | contract kit + smoke against the **real** server with `fixtures/opencode/fake-provider.mjs` (OpenAI-compatible SSE on 127.0.0.1, no credentials): probe, anonymous 401 observed, password-less server refused, project `.opencode` plugin / `opencode.json` refused (plugin never ran), `AGENTS.md` + operator override do not loosen bash, approve / deny / timeout, deny-sensitive and webfetch denied without asking, follow-up delivery, graceful and forced cancel during bash with process check, resume after server restart, usage fields, password visible to tool shells (documents finding 2) |
| `opencode-live.test.ts` | `REMYRAL_LIVE_RUNTIMES=1` + `REMYRAL_OPENCODE_BIN` (+ model, auth) | **needs the owner's login or an API key**: one-prompt repository edit with approvals and a live cancel |

## 8. Security review

### OpenCode

- **Fail-closed server (ADR-0012 rule 2):** random 32-byte password via env only, explicit `--hostname 127.0.0.1`, explicit
  port, anonymous `/session` must be 401 before use, served version must equal the probe, Basic auth only over loopback.
- **Policy beats repository (rule 3):** project config off, complete config-level map and session ruleset, effective-config
  verification at start and during the run, private config/cache/state dirs (the user's global opencode config and
  plugins are not loaded), `plugin: []`, `--pure`. Because 1.19.0 still loads project `.opencode` plugins (§6.5.1), such
  workspaces are refused outright. **Residual (high, blocking for untrusted repos on host profiles):** the guard checks the
  workspace before start only; a later `.opencode/` created by an approved tool takes effect on `resume` (checked again
  there) — and finding 6.5.2 lets an approved bash call drive the server API. Both must be contained by the sandbox
  (container profile without access to the server port from tool processes, p3-sandbox follow-up) and reported upstream.
- **Route allowlist:** the adapter itself can only call 10 routes; ids are format-checked, so no path injection.
- **Secrets:** provider keys via env only; the server password is per job and never leaves the adapter (not in events,
  refs, probe notes); every event text is redacted with all job secrets.
- **local-login:** `XDG_DATA_HOME` stays the user's so OpenCode finds its own `auth.json`; the adapter never opens it
  (`opencode providers list` is parsed for the credential count only).

### Pi

- **Untrusted repository (ADR-0010/0012 rule 3):** `--no-approve` (no project `.pi` settings/extensions/MCP), `--no-extensions`
  + only our gate, `--no-skills/--no-prompt-templates/--no-themes/--no-mcp`, `--no-context-files` for untrusted repos,
  explicit `--session-dir` (the project `sessionDir` setting is read before trust resolution). Verified with a hostile
  workspace.
- **Approvals are advisory, not containment.** The gate runs in-process; an approved bash call can do anything the OS user
  can. `approval` is reported `degraded` for that reason; the sandbox (ADR-0007) is the boundary.
- **Secrets:** env only (never `--api-key`), `assertNoSecretsInArgv` in the process helper, every event text redacted;
  the gate policy env is non-secret. Residual: the model can read env vars through bash (inherent to env injection; a
  per-job short-lived key limits the blast radius) and partial echoes of a secret are not matched by value redaction.
- **local-login:** the adapter never reads Pi's files; the probe uses `pi auth check` without `--credentials`.
- **State dir:** run dirs and transcripts are 0700 under the caller's `stateDir`; runtime session ids are canonical UUIDs
  (path components); `cleanup` removes the run dir (gate, agent dir), `purgeTranscript` the transcript.
- **Fail-closed:** unknown records, a gate without policy, unanswerable dialogs, approval timeouts and an unconfirmed
  session id all end in deny/failure, never in silent success.

## 9. Rollback, operations

Additive (new modules + exports); nothing in `apps/*` uses them yet. Rollback = revert the commits. Metrics to wire in
`p6-otel`: cancel mode/latency per runtime, `runtime_protocol_error` count (schema drift alarm), approval timeouts,
`runtime_crashed` by exit, descendant groups killed by the sweep (non-zero = the runtime did not clean up),
`approval_bypass_detected` (alarm), workspaces refused for OpenCode project config, OpenCode start-up latency.

## 10. Open items (UNVERIFIED / follow-ups)

- Every OS/arch other than macOS arm64 (capabilities report `unverified` there until the real-binary suites have run).
- Credentialed runs (`pi-live`, `opencode-live`): real provider payloads, cost accuracy, usage-limit errors
  (`provider_usage_limit`, ADR-0014) — need the owner's login or a low-budget key.
- OpenCode under the `container` profile: the server must be reachable from the worker on 127.0.0.1 while tool processes
  must not reach it (finding 6.5.2) — needs a p3-sandbox design for loopback servers.
- Upstream reports: OpenCode v2 config ignores `OPENCODE_DISABLE_PROJECT_CONFIG`; Pi/OpenCode tool process groups.
