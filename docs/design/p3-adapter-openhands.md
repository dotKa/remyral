# Design note: p3-adapter-openhands

> **Removed (2026-10-15):** the OpenHands adapter was deleted by [ADR-0023](../adr/0023-remove-openhands.md). This note is historical.

- **Task:** `p3-adapter-openhands` (OpenHands Agent Server 1.54.0 over REST + WebSocket)
- **Package:** `packages/agent-adapters/src/runtimes/openhands` — factory `createOpenHandsAdapter(opts)`
- **Date:** 2026-10-13
- **Binding inputs:** docs/compat/{README,openhands,handson-2026-10-13}.md, ADR-0007, ADR-0008, ADR-0010, ADR-0012,
  ADR-0013, ADR-0014, docs/design/p3-adapter-contract.md, docs/design/p3-adapter-pi-opencode.md (patterns reused:
  `runtimes/common`, descendant process-group sweep, refusing hostile repo config, detecting approval bypass through a
  leaked server credential), docs/design/p3-sandbox.md
- **Pins:** `openhands-agent-server`, `openhands-sdk`, `openhands-tools`, `openhands-workspace` ==1.54.0 (CPython 3.12
  via `uv`); image `ghcr.io/openhands/agent-server:1.54.0-python@sha256:0823688…f136f8` (index digest, §8)
- **Evidence labels:** VL = verified here against the pinned server (macOS 26 arm64, CPython 3.12.13), VS = read in the
  pinned source (installed wheels), U = unverified.

## 1. Scope

A real adapter behind the p3 contract: probe + version gate, truthful capabilities, a fail-closed per-session Agent
Server under the caller's `ProcessConfiner`, conversation on the job workspace, prompts and follow-ups, events from the
WebSocket mapped to protocol `AgentEvent`s with usage/cost, approvals through confirmation mode, cancel, resume,
result, artifacts, cleanup, cost. Out of scope (as for Pi/OpenCode): wiring into `apps/worker`, secret resolution,
profile selection; the interactive Canvas sessions of ADR-0013 (the design leaves room for them, §9).

All routes, fields and messages were taken from the pinned server's live `GET /openapi.json` (145 paths,
`info.version` 1.54.0) and from WebSocket frames recorded from it. The adapter's route table and the request/response
fields it uses are checked against `test/fixtures/openhands/openapi-1.54.0.subset.json` (generated from the live
document by `make-openapi-subset.mjs`); `@openhands/typescript-client` is not used (no route allowlist; Node use U).

## 2. Server process (ADR-0012 rule 2, rule 4)

One Agent Server per session, started by `startLoopbackServer` (process group, minimal env, caller's confiner):

```
<command> [commandArgs…] --host 127.0.0.1 --port <free port>     # e.g. <venv>/bin/python -m openhands.agent_server
cwd = <stateDir>/storage/<id>/run/cwd                               # private and empty — never the workspace
env: OH_SESSION_API_KEYS_0=<32 random bytes>  (secret env, never argv)
     OPENHANDS_AGENT_SERVER_CONFIG_PATH=<run>/agent-server-config.json   (ours, 0600, no key in it)
     HOME=<run>/home  OH_PERSISTENCE_DIR=<run>/home/.openhands  XDG_{CONFIG,CACHE,DATA,STATE}_HOME=<run>/xdg/*
     OH_ENABLE_VSCODE=false OH_ENABLE_BROWSER=false LITELLM_LOCAL_MODEL_COST_MAP=True DO_NOT_TRACK=1
     OPENHANDS_SUPPRESS_BANNER=1 LOG_JSON=true LOG_LEVEL=WARNING
     + provider keys from SpawnContext.secretEnv (e.g. OPENAI_API_KEY / ANTHROPIC_API_KEY — LiteLLM reads them)
config: conversations_path / bash_events_dir under the kept storage dir; workspace_path / worktree root private;
        webhooks [], enable_vscode/browser false, CORS none, trust_forwarded_headers false, max_concurrent_runs 1,
        deferred_init false, conversation_runtime local, registered_marketplaces [], telemetry exporter none
```

- **`--host 127.0.0.1` always** — with a session key set and no `--host`, 1.54.0 binds all interfaces (handson
  finding 4). VL: `lsof` shows only `127.0.0.1:<port>` (real test).
- **Fail-closed start:** authenticated readiness on `GET /api/conversations/count`, then the same route **anonymously
  must be 401** (`/health`, `/server_info`, `/openapi.json` are public by design). Anything else kills the server
  (`UnsafeServerError`). VL: the real binary started without its key is refused (probe note "fail-open").
- **Why our own config file and a private cwd:** the server reads `workspace/openhands_agent_server_config.json`
  relative to its cwd by default (VS `config.py`); with cwd = workspace a repository could configure webhooks, CORS,
  conversation paths. The env/JSON prefix `OH_*`, `OPENHANDS_*`, `LITELLM_*`, `LMNR_*`, `OTEL_*` and `SESSION_API_KEY`,
  `DEBUG*`, `LOG_*`, `EXTENSIONS_REF`, `HOME`, `XDG_*` are stripped from the operator env; a job secret with such a
  name is refused (a second `OH_SESSION_API_KEYS_1` would be a second valid key).
- **Credentials (ADR-0014):** only `secret-ref`. Provider keys go to the server env only; the conversation request has
  no `api_key` (LiteLLM falls back to the provider's env var — VL with `OPENAI_API_KEY`). `local-login` is reported
  unsupported (probe `authenticated: no` + note; spawn refused): LiteLLM providers need keys, and the OpenAI
  "subscription" device flow of 1.54.0 (`/api/llm/subscription/openai/*`) is driven through the server API and stores
  tokens under `~/.openhands` — not a runtime-owned interactive login we could leave untouched (U, not attempted).
- **Start-up time (VL):** first start of a fresh venv 38 s; warm 6–12 s on an idle machine; 15–60 s and once 234 s
  with load average ~39 (other suites running). Callers must give `timeouts.startupMs` ≥ 300 s on first use; probe
  default `probeTimeoutMs` = 300 s. Bytecode is written at first start (do not set `PYTHONDONTWRITEBYTECODE`).

### 2.1 Probe and version gate

`probe()` starts a throw-away server exactly like a job (same fail-closed checks), reads `GET /server_info`
(`version`, `sdk_version`, `tools_version`, `workspace_version`; a split install is reported as
`1.54.0+sdk-x` and therefore not the pin) and stops it — nothing is sent to a model. A version ≠ 1.54.0 gives an
all-`unverified` set (`applyVersionGate`); `spawn` refuses it unless `allowUnverified`. Every job server's
`/server_info.version` must equal the probed version (`UnsafeServerError`). `probeCacheMs` (default 0) lets a worker
reuse a probe of the same command line process-wide.

## 3. Conversation (our policy beats repository policy)

`POST /api/conversations` with a client-chosen `conversation_id` (UUID), `workspace.working_dir = workspaceRoot`,
`worktree: false` (the worker owns isolation), `confirmation_policy: AlwaysConfirm`, `security_analyzer: null`,
`max_iterations` (default 500), `stuck_detection: true`, `autotitle: false` (no extra LLM call), `secrets: {}`,
`plugins: null`, `hook_config: null`, `tags {remyraljob, remyralattempt}`, and `agent_settings`:
`agent_kind: openhands`, `llm {model, base_url?, usage_id:"agent", operator settings from an allowlist}`,
`tools: [terminal {terminal_type: subprocess on POSIX}, file_editor, task_tracker]` (no browser, delegation,
LLM switching), `mcp_config: {}`, `enable_classify_and_switch_llm_tool: false`,
`agent_context {load_project_skills: trusted, load_user_skills: false, load_public_skills: false, load_memory: false,
registered_marketplaces: []}`.

The returned `ConversationInfo` must match (fail-closed, `UnsafeServerError`): id, realpath(`working_dir`) =
realpath(workspace), `confirmation_policy.kind = AlwaysConfirm`, `hook_config` null, exactly our tool names, empty
`mcp_config`, no user/public skills or memory, no project skills for untrusted repositories. The first WebSocket
frame (`full_state`) is checked again. The subprocess terminal is forced because the tmux backend daemonises outside
our process tree (VS `factory.py`).

## 4. Events (WebSocket → protocol)

`WS /sockets/events/{id}?resend_mode=all` (resume: `resend_mode=since&after_timestamp=<latest stored event>`),
**first-frame auth** `{"type":"auth","session_api_key":…}` (no key in URLs or headers; VL `sockets.py`). There is no
auth acknowledgement: the adapter waits for the first `full_state` frame; close 4001/4004 is fatal. Frames are JSON,
≤ 4 MiB, validated with Zod (`schema.ts`) and **deduplicated by event id** (the server subscribes before it replays,
so a replay can overlap live events; `full_state` is synthesised per connect and never deduplicated). A socket that
closes while the server lives is reconnected up to 3 times with `resend_mode=since`; then `event_stream_lost`.

| OpenHands 1.54.0 event (recorded) | Protocol event / action |
|---|---|
| `sendPrompt` → `POST …/events {role:user, content:[text], run:true}` | `message{user}` + `status: running` (first prompt) |
| `MessageEvent{source:user}` | matched against our prompts — a foreign user message ⇒ `external_control_detected` |
| `MessageEvent{source:agent, role:assistant}` | `message{assistant}` (non-empty text) |
| `ActionEvent` | `tool_call{callId=tool_call_id, toolName, inputSummary=action JSON ≤2000}` |
| `ObservationEvent` | `tool_result{ok=!is_error, outputSummary}`; `finish` observation also → `message{assistant}` |
| `UserRejectObservation` | `tool_result{ok:false, "rejected: <reason>"}` |
| `AgentErrorEvent` (e.g. "Tool call interrupted…") | `tool_result{ok:false}` for its call, else `error{agent_error}` |
| `ConversationStateUpdateEvent stats` (accumulated per usage id) | `usage` **increment**: Δprompt−Δcache_read → `inputTokens`, Δcompletion → `outputTokens`, cache read/write, `turns:1`, `durationMs`, provider/model from `model_name` (`openai/scripted` → `openai`, `scripted`), `authMode`; `costUsd` = Δ`accumulated_cost` with `reported-by-runtime` only if > 0, else `estimated-from-tokens` |
| `execution_status waiting_for_confirmation` | adapter decision (§5) or `approval_request` + `waiting_approval` |
| `execution_status finished` | capture artifacts, shut down, `stopped` (succeeded; failed if a run error was seen) |
| `execution_status error` + `ConversationErrorEvent{code}` (recorded order: status first) | `error{snake_case(code)}` (e.g. `llm_bad_request_error`), `stopped` (failed) |
| `execution_status stuck` | `error{agent_stuck}`, failed |
| `execution_status paused` not caused by our cancel | `external_control_detected` |
| `execution_status idle` after our rejection | `POST …/run` (the agent continues and sees the rejection) |
| `idle` otherwise (e.g. final iteration with a pending message), confirmed by `GET` after 1.5 s | `error{run_stopped}`, failed |
| `confirmation_policy` / `hook_config` state update, `HookExecutionEvent` | `approval_bypass_detected` (§6) |
| `SystemPromptEvent`, `Pause/InterruptEvent`, `Token/StreamingDeltaEvent`, `LLMCompletionLogEvent`, condensation, `SecurityAnalysisEvent` | ignored |
| any other `kind` / invalid shape | `error{runtime_protocol_error}`, failed (schema drift must surface) |
| server exit not caused by us | `error{runtime_crashed}` + redacted stderr tail, failed |

Recorded transcripts (`test/fixtures/openhands/transcripts/*.json`): echo, approval accept, approval reject + run,
terminal interrupt, provider error, finish tool, resume replay, repository plugin hook, follow-up implicit confirmation. Every text passes
`redactSecrets` with the job secrets **and the session key**; every event is validated against `AgentEvent`.

**Cost provenance:** OpenHands prices tokens with LiteLLM's bundled table (`LITELLM_LOCAL_MODEL_COST_MAP=True`, the
pinned LiteLLM 1.105.0 map) or with operator `input/output_cost_per_token`. It is an estimate; an unknown model is
priced 0, which the adapter reports as tokens only. `getCost` sums the increments. Accuracy against provider billing: U.

## 5. Approvals

OpenHands' `ConfirmRisky` decides from the model's self-reported `security_risk` — a value a prompt-injected model
controls. The adapter therefore always uses **`AlwaysConfirm`** (OpenHands never confirms a lone `finish`/`think`)
and decides per batch of pending actions itself:

| policy | `file_editor view` of a path inside the workspace (realpath, symlinks resolved) | anything else |
|---|---|---|
| `ask-all` | ask | ask |
| `ask-sensitive` | accept | ask |
| `deny-sensitive` | accept | reject (nobody asked) |

Without an offered `approval` capability "ask" becomes "reject". A batch is accepted automatically only if every action
in it is. "Ask" emits one `approval_request{approvalId = "oh-<first action id>", action: runtime.dangerous_tool,
description = one line per action (e.g. `terminal: echo approved > approved.txt`), risk high (terminal/other) or
medium (file editor)}`; `requestApproval` answers `respond_to_confirmation {accept, reason}`; no answer within
`approvalMs` ⇒ reject. **A rejection leaves the conversation `idle` in 1.54.0 (VL)**; the adapter then calls
`/run`, so the agent sees the rejection and continues (VL: it finishes).

**Finding — implicit confirmation:** in 1.54.0 a new run (`POST …/run`, or a message with `run: true`) **executes
actions that are still waiting for confirmation** ("Check for pending actions (implicit confirmation)",
`sdk/agent/agent.py`, VS). VL: on the raw server a follow-up `{run:true}` sent while `echo approved > approved.txt`
waited for confirmation ran the command (`approved.txt` written; transcript `followup-implicit-confirmation`); before
the fix below the adapter's tamper check failed such a job. The adapter therefore rejects every waiting action
(`respond_to_confirmation {accept:false, reason:"superseded by a new user message"}`) before it sends a follow-up and
voids the matching approval request; VL: the command never runs and the follow-up is answered. For anyone holding the
session key (§6), `/run` is thus a one-call self-approval.

## 6. Tamper detection (the session key is readable by tool processes)

`sanitized_env()` strips `OH_SESSION_API_KEYS_*`, `SESSION_API_KEY` and `OH_SECRET_KEY` from terminal environments
(VS, VL: `env | grep -c` → 0), **but** the server runs as the same OS user, and `ps eww -p $PPID` from a tool shell
prints the server's environment including the key (VL on macOS: 1 match; on Linux `/proc/<pid>/environ` is readable
by the same user, U). An approved command can therefore answer later confirmations, change the policy, run commands
through `/api/bash`, or start an unconfirmed second conversation. Detection (job failed with
`approval_bypass_detected`/`external_control_detected`, never silently continued):

- an action result for an action the adapter did not accept (or an action that never waited for confirmation) —
  this also catches a foreign `/run` (implicit confirmation, §5),
- a rejection of an action the adapter accepted,
- status `paused` without our cancel, a user message we did not send,
- `confirmation_policy` ≠ AlwaysConfirm or non-null `hook_config` in a state update / `full_state`, a `HookExecutionEvent`,
- a policy watch every 5 s while running: conversation policy/hooks/MCP, `/api/conversations/count` = 1,
  `/api/bash/bash_events/search` empty.

Not prevented ⇒ `approval: degraded`. Mitigation candidates (follow-ups): run tool processes under another uid or in
the container profile with no access to the server port; deliver the key through a config file that is deleted after
start (the server would keep it in memory only — U, deviates from ADR-0012's env rule, needs an ADR note).

## 7. Repository content OpenHands 1.54.0 loads (hostile repository review)

Read in the pinned source (`LocalConversation._ensure_agent_ready`, `sdk/plugin/discovery.py`,
`sdk/subagent/registry.py`, `sdk/skills/skill.py`, `sdk/context/agent_context.py`) and checked with the real server:

| Repository content | 1.54.0 behaviour | Adapter |
|---|---|---|
| `.agents/plugins/*/`, `.openhands/plugins/*/` (workspace **and git root**; any sub-dir, no manifest) | **always loaded**: `hooks/hooks.json` shell hooks (SessionStart, Pre/PostToolUse…), `.mcp.json` stdio MCP servers, sub-agents, skills — no request field or env var disables it | **workspace refused** (`InvalidSpawnContextError`) before any server starts. VL: without the guard a `SessionStart` hook ran `touch PWNED` before the first model call (transcript `repo-plugin-hook`) |
| `.agents/agents/*.md`, `.openhands/agents/*.md` | always registered as sub-agents; front matter may set `permission_mode: never_confirm`, tools, MCP, hooks | refused (same guard; the task/delegate tools are not enabled anyway) |
| `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.openhands/{skills,microagents}`, `.agents/skills` | loaded only with `load_project_skills` | `true` only for `repositoryTrust: trusted` (ADR-0010). VL: an `AGENTS.md` canary never reached the model for an untrusted repo and did for a trusted one |
| `.openhands/hooks.json` | only read by `GET /api/hooks` for a client to pass as `hook_config` | never used (`hook_config: null`) |
| `.openhands/setup.sh`, pre-commit scripts | nothing executes them in sdk/agent_server/tools/workspace (VS grep) | VL: not executed |
| `.mcp.json` at the repository root (outside a plugin dir) | not read | VL: not executed |
| `.openhands/memory/` | only with `load_memory` | `false` |
| `workspace/openhands_agent_server_config.json` | server config relative to the **server cwd** | cwd is private; explicit config path |

The guard runs before every start (spawn and resume). Residual: a plugin directory created by an approved tool takes
effect on the next start (resume re-checks) — and approved tools are not contained by the adapter anyway (§6, §10).

## 8. Cancel, process ownership, container profile

`cancel` → `stopping` → pending approvals dropped → `POST …/interrupt` (bounded by `cancelGraceMs`) and wait for
`paused` → shutdown → `stopped` (`cancelled`); `graceful` if paused within the grace, else `forced`; `cancelMs` bounds
everything (`CancelTimeoutError` after a tree kill). **Interrupt does not stop a running terminal command** (VL:
`sleep 711 & sleep 712` kept running after `paused`); `bash_commands/{id}/stop` only covers commands started through
the `/api/bash` routes, not the agent's terminal tool (VL: `bash_events` empty while the agent's command ran), so it
is not part of cancel. Every terminal command runs in its own process group (`setsid` PTY + job control, VL), so
shutdown snapshots descendant groups (`snapshotDescendantGroups`), SIGTERM → grace → SIGKILL of the server group,
SIGKILL of the snapshotted groups, `dispose()` (confiner cleanup). VL: graceful and forced cancel during a running
`sleep` leave no process. Also VL: an interrupted in-flight LLM request is **not** aborted (the HTTP connection stays
open) and a follow-up run on the same server blocks behind it — irrelevant for us because cancel ends the server.
`safe_cancel: degraded` (processes that left the tree are reaped only by the sandbox).

**Container profile (Linux):** the pinned image is `ghcr.io/openhands/agent-server:1.54.0-python@sha256:
082368832a7e48087b64da38c7b2cf2442dd7621fde69f8d06ed52283ff136f8` (index; linux/amd64 `0e0ce6f6…`, linux/arm64
`ddf2131e…`), verified 2026-10-13 with `docker buildx imagetools inspect` and the GHCR registry API; config: user
`openhands`, entrypoint `tini -- /usr/local/bin/openhands-agent-server`, `EXPOSE 8000`, `OH_ENABLE_VSCODE=true`
(overridden by our env), build ref `refs/tags/v1.54.0`. The p3-sandbox container runner publishes **no ports**, so a
confined server would be unreachable from the worker; the adapter refuses `sandboxProfile: 'container'` unless the
confiner declares `confinerPublishesLoopbackPort` (follow-up for p3-sandbox: publish `127.0.0.1:<port>` only, and keep
tool processes from reaching it). Not run in a container here (U).

## 9. Resume, artifacts, long-lived mode

- **Resume (same worker, VL):** conversations persist in `<stateDir>/storage/<id>/conversations` (kept after
  `cleanup` until `purgeTranscript`; index `<stateDir>/index/<conversation>.json`). `resume` restarts a server (new
  key) on that store, re-creates the conversation with the same id (**idempotent create: 200 instead of 201**, VL),
  takes the old `stats` as usage baseline and the latest stored event's timestamp as replay cursor; all stored events
  at that timestamp (`events/search?timestamp__gte=`) are marked seen, because `resend_mode=since` is inclusive and
  several events can share a timestamp — nothing is re-emitted.
  No provider secret is persisted (keys are env-only; without `OH_SECRET_KEY` the server would redact them anyway).
- **Artifacts:** at run end, before shutdown: `agent_final_response`, `git/changes?path=<workspace>` and per changed
  file `git/diff?path=<file>` (≤ 100 files, ≤ 512 KiB, redacted; the route returns original/modified *contents*,
  trailing newline trimmed — VL) → `getArtifacts(ref)`; the final response is the
  result summary. Not captured after cancel/crash. The worker's own git diff stays authoritative (`degraded`).
- **ADR-0013 (interactive sessions):** server start (`startServer`), the REST client, the event socket and the mapper
  are independent of the per-job lifecycle; a long-lived interactive mode can start one server, keep its key in the
  worker, and attach conversations to it. Cancel there must not kill the server: interrupt + kill of the conversation's
  terminal process groups (descendants of the server minus the server group) — to be designed with p5-live.

## 10. Capabilities (Agent Server 1.54.0; darwin-arm64 contract-tested 2026-10-13, elsewhere `unverified`)

| Capability | Status | Reason |
|---|---|---|
| streaming | supported | event-level WS stream (no token deltas; `stream` off) |
| interactive_prompt | supported | follow-ups join the running conversation; a waiting action is superseded |
| approval | **degraded** | native confirmation, adapter-side decision; bypass via the readable session key detected, not prevented |
| cancel | supported | interrupt → paused, then tree kill |
| resume | **degraded** | same worker, restart on the kept store |
| cost_reporting | **degraded** | LiteLLM price estimate; 0 ⇒ tokens only |
| artifacts | **degraded** | final response + git changes/diffs captured at run end, not on cancel |
| safe_cancel | **degraded** | interrupt leaves terminal commands running; group snapshot + sweep |

## 11. Tests

| Suite | Runs | What |
|---|---|---|
| `openhands-units.test.ts` | always | 9 recorded transcripts → protocol events (all valid `AgentEvent`s; usage increments; approval/reject/interrupt/error/finish/resume/plugin-hook/implicit confirmation); dedupe and cursor; redaction; unknown kinds fail; route allowlist, query params, security and request/response fields vs the pinned OpenAPI subset; UUID-only path params; socket URL without credential; approval policy table incl. symlink escape; control-env names; workspace guard (workspace + git root); capability table; image digest |
| `openhands-adapter.test.ts` | always | contract kit ×3 against `fixtures/openhands/fake-openhands.mjs` (real REST/WS shapes, RFC 6455 server with first-frame auth): tested platform, untested platform, version drift + `allowUnverified`; plus server argv/env/config (key env-only, operator control env stripped, private cwd/HOME), conversation request (AlwaysConfirm, tools, trust-dependent skills, no api_key), plugin/sub-agent workspaces refused (also via git root), container/local-login/control-secret refusals, fail-open refused, bad policy refused, version gate, crash, unknown event, provider error code, five tamper signals + extra conversation, session key redacted, forced cancel with real process-group sweep, approval not offered ⇒ reject, deny-sensitive + workspace view, superseded approval, finish tool, resume without replay + unknown conversation, usage/cost incl. zero cost, artifacts |
| `openhands-real.test.ts` | `REMYRAL_OPENHANDS_PYTHON=<venv python>` | contract kit + smoke against the **real** 1.54.0 server with `fixtures/openhands/fake-provider.mjs` (OpenAI-compatible, 127.0.0.1, through LiteLLM; no credentials, no network): probe, anonymous 401 before create, key-less server refused, loopback-only listen (`lsof`), hostile repository (plugin hook + sub-agent refused, AGENTS.md/skills/microagents not sent to the model when untrusted and sent when trusted, setup.sh/.mcp.json not executed), approve/deny/timeout, deny-sensitive, workspace view vs outside view, follow-up, graceful/forced cancel during `sleep` with process check, resume after restart, artifacts, key stripped from env but readable via `ps` |
| `openhands-live.test.ts` | `REMYRAL_LIVE_RUNTIMES=1` + `REMYRAL_OPENHANDS_PYTHON` + key | **needs a provider key**: one-prompt repository edit with approvals, usage, cost, artifacts; live cancel |

## 12. Security review

- **Fail-closed server (ADR-0012 rule 2):** random 32-byte key via env only, explicit `--host 127.0.0.1`, explicit
  port, anonymous `/api/*` must be 401 before use, served version must equal the probe, conversation and first state
  frame must carry our policy. The key travels only in `X-Session-API-Key` over loopback and the first WS frame; it is
  redacted from every event, result and note.
- **Route allowlist:** 14 routes (no bash, file, settings, profiles, skills/plugins install, MCP, canvas-extension,
  `init` routes); path parameters are canonical UUIDs.
- **Policy beats repository (rule 3, ADR-0010):** `AlwaysConfirm` + adapter decision, explicit tools, no MCP/hooks/
  plugins/marketplaces/public or user skills/memory, project skills only when trusted, private HOME/persistence dir/
  config/cwd, workspaces with auto-loaded plugins/sub-agents refused (§7).
- **Residual (high, blocking for untrusted repositories on host profiles):** the session key is readable by tool
  processes (§6) — an approved command can self-approve later actions or drive the server API; detected (job fails)
  but not prevented. Approved commands run as the worker's OS user with the provider key in their environment
  (inherent to env injection; per-job short-lived keys limit the blast radius). Untrusted repositories therefore need
  the container profile, which first needs the loopback-port follow-up (§8). OpenHands has no network sandbox; egress
  control is the sandbox's job.
- **Telemetry/network:** telemetry exporter `none`, `DO_NOT_TRACK=1`, no public skills/marketplaces, no LiteLLM
  price-map download, no Laminar/OTEL (env stripped). The only outbound traffic is the LLM provider (U: not verified
  with an egress capture; the scripted provider saw only `/chat/completions`).
- **State at rest:** run dirs 0700, config 0600; conversations hold prompts/outputs (redaction applies to events, not
  to the server's own store — like Pi/OpenCode transcripts); `purgeTranscript` deletes them.

## 13. Rollback, operations

Additive (new module + export, fixtures, docs); nothing in `apps/*` uses it yet. Rollback = revert the commit.
Metrics for `p6-otel`: server start-up latency (probe note), cancel mode/latency, `runtime_protocol_error` (schema
drift), `approval_bypass_detected`/`external_control_detected` (alarm), approval timeouts, workspaces refused for
plugin/sub-agent dirs, descendant groups killed by the sweep, `runtime_crashed` by exit.

## 14. Open items (UNVERIFIED / follow-ups)

- Every OS/arch other than macOS arm64 (capabilities `unverified`), Windows (PowerShell terminal), Linux `/proc` key
  exposure, Raspberry Pi memory.
- Container profile: port publishing in the p3-sandbox runner + keeping tools away from the port; run the pinned image.
- Credentialed run (`openhands-live`): real provider payloads, cost accuracy, rate-limit/usage errors, token streaming.
- `local-login` (OpenAI subscription device flow of 1.54.0): not evaluated.
- Key delivery that tools cannot read (deleted config file / other uid) — needs an ADR-0012 amendment.
- Upstream reports: repository plugins/sub-agents load unconditionally; a new run implicitly confirms waiting actions;
  interrupt leaves terminal commands running and
  in-flight LLM requests open; default bind flips to 0.0.0.0 when a key is set.
