# Design note: p3-adapter-contract

- **Task:** `p3-adapter-contract` (adapter interface, capability model, contract test kit, fake runtime)
- **Package:** `packages/agent-adapters` (`@remyral/agent-adapters`, test kit at `@remyral/agent-adapters/testing`)
- **Date:** 2026-10-12
- **Inputs:** ARCHITECTURE.md "Agent adapter contract", ADR-0004, ADR-0006, ADR-0007, ADR-0008, ADR-0010, ADR-0012, docs/compat/\*
- **Acceptance:** A-RT-TRUTH (shared; per-runtime A-RT-\* come with `p3-adapter-*`)

## 1. Scope

In scope: the `AgentAdapter` TypeScript contract, the truthful capability model, typed errors, the
process-tree helper, the fail-closed loopback-server helper, the line-delimited JSON stdio transport, a
deterministic fake runtime, and the contract test kit every real adapter must pass.

Out of scope: the five real adapters (`p3-adapter-*`), sandbox profiles and the low-privilege OS user
(`p3-sandbox`), secret resolution from the keystore and output redaction pipeline (`p3-secrets-worker`), and
workspace allowlisting (`p3-workspace`). This package consumes their results through `SpawnContext`.

## 2. Contract

```ts
interface AgentAdapter {
  readonly runtime: RuntimeKind;
  probe(): Promise<ProbeResult>; // version, auth, os/arch, CapabilitySet
  capabilities(): CapabilitySet; // last probe; all `unverified` before probe
  spawn(ctx: SpawnContext): Promise<SessionRef>;
  sendPrompt(ref, { text }): Promise<void>; // 2nd+ prompt requires interactive_prompt
  events(ref, cursor?, signal?): AsyncIterable<SequencedEvent>;
  requestApproval(ref, decision): Promise<void>; // requires approval
  cancel(ref, reason?): Promise<CancelOutcome>; // graceful | forced | already-stopped
  resume(ref, ctx): Promise<SessionRef>; // requires resume
  collectResult(ref): Promise<SessionResult>; // SessionStateError while live
  cleanup(ref): Promise<void>; // idempotent
  getCost(ref): Promise<CostReport>; // provenance always; 'unknown' allowed
}
```

Key decisions:

- **Events.** `SequencedEvent = { seq, at, event: AgentEvent }` where `AgentEvent` is the protocol v1
  normalized union. `seq` starts at 1 and is gapless per session; `events(ref, { afterSeq })` resumes without
  duplicates. The stream ends after exactly one terminal `status: stopped`. `SessionEventLog` implements
  this once (bounded retention; an expired cursor raises `CursorExpiredError` rather than silently skipping).
  The worker maps `seq` onto the protocol EVENT envelope `seq` and its replay cursor (p2-replay).
- **Spawn vs. prompt.** `spawn` starts the runtime/session but sends nothing to a model; the first
  `sendPrompt` starts the run. This matches every chosen surface (`thread/start` + `turn/start`, `POST /session`
  + `prompt_async`, SDK input iterable, Pi `prompt` command, OpenHands conversation + `run:true`).
- **Cancel** always exists, because the worker owns the process tree; a runtime without a native interrupt
  reports `cancel: degraded` (cancel = tree kill). `cancel()` resolves only after the terminal status, or
  rejects with `CancelTimeoutError` after `timeouts.cancelMs`. Aborting `ctx.signal` is equivalent to
  `cancel()` (CANCEL_JOB, lease loss).
- **Cost** never throws for a missing capability: `getCost` returns `{ provenance: 'unknown' }`.
- **SpawnContext** carries: `jobId`, `attemptId`, absolute already-allowlisted `workspaceRoot`, the job-spec
  subset (`runtime`, `runtimeVersion`, `model`, `prompt`, `limits`), `sandboxProfile`, `approvalPolicy`,
  `repositoryTrust`, the required `repoConfig: 'ignore-repository-config'` (§6), `secretEnv` (opaque
  `SecretValue` handles), `timeouts` (`startupMs`, `cancelGraceMs`, `cancelMs`, `approvalMs`,
  `maxDurationMs`), `allowUnverified`, and an `AbortSignal`. `assertSpawnContext` validates it.

## 3. Truthful capabilities (ADR-0008)

- Capabilities = protocol `Capability` enum plus the local `safe_cancel` (process tree reaped, no tool
  keeps running) — every runtime can stop a turn, none guarantees a safe cancel (compat §4.3).
- A `CapabilitySet` is keyed by `(runtime, version, os, arch)`; every capability has a status
  (`supported | degraded | unsupported | unverified`); everything except `supported` must carry a reason.
  `defineCapabilitySet` fills anything unmentioned with `unverified` — silence is never support.
- `requireCapability(set, cap, { allowUnverified })` throws `CapabilityUnsupportedError`
  (`code: 'capability_unsupported'`) unless the capability is offered (supported/degraded, or unverified with
  explicit policy). Adapter methods for missing capabilities reject with it; they never fake success.
- **Version gate (ADR-0012 rule 1):** `applyVersionGate` downgrades every offered capability to `unverified`
  when the installed version is not the pin; `spawn` rejects with `VersionMismatchError` unless policy sets
  `allowUnverified`. `toProtocolCapabilities` projects onto the protocol CAPABILITIES payload.
- The contract kit is the only source of `supported`: adapters must ship the set their contract tests pass
  on that OS/arch and report anything else as `unverified` (compat "U" rows).

## 4. Building blocks

| Module                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/process/`               | `spawnOwnedProcess`: POSIX `detached` (own process group, kill `-pid`), Windows `taskkill /PID <pid> /T /F`; `terminate({graceMs})` = graceful tree signal → grace → tree kill, and the tree is always force-killed at the end so grandchildren that ignored SIGTERM do not survive; exit info via `exit` (not `close`); bounded, redacted stdout/stderr tails; env allowlist (worker env not inherited); secrets env-only, `SecretInArgvError` if a secret value appears in argv. |
| `src/loopback-server.ts`     | `startLoopbackServer`: free 127.0.0.1 port, 32-byte random secret in an env var, spawn via the process helper, authenticated readiness poll with timeout, then **an unauthenticated request must get an expected refusal (default 401/403)** — otherwise the server is killed and `UnsafeServerError` is thrown.                                                                                                                                         |
| `src/stdio-jsonl.ts`         | `JsonlTransport`: LF-only splitting on bytes (CR stripped, U+2028 safe, multibyte safe), max line size, Zod schema hook on every inbound line, request/response correlation with per-request timeouts, ordered notification/server-request stream with a bounded queue, `respond()` for runtime→us requests, fail-closed on bad lines by default, clean `close()`. Codecs: generic `JsonlCodec`, plus `jsonRpcCodec`.                         |
| `src/event-log.ts`           | `SessionEventLog`: sequencing, retention, resumable concurrent readers.                                                                                                                                                                                                                                                                                                                                                                         |
| `src/fake/`                  | `FakeRuntimeAdapter`: deterministic scripted runtime (messages, tool calls, usage, approval requests with fail-closed timeout, crash, slow/forced/hanging cancel, secret-leak step for negative tests) with configurable capabilities and version drift.                                                                                                                                                                                        |
| `src/testing/contract-suite` | `defineAdapterContractSuite(name, factory, options)`; see §5.                                                                                                                                                                                                                                                                                                                                                                                   |

## 5. Contract test kit

`defineAdapterContractSuite` registers, per adapter: probe shape (complete reasoned set, version-gate
consistency, `capabilities()` equals probe); truthful `interactive_prompt` / `approval` / `resume` (offered ⇒
no `CapabilityUnsupportedError`; not offered ⇒ exactly that error); approve flow when offered; gapless ordered
events with exactly one terminal status, resumable from several cursors, identical for concurrent readers;
`collectResult` refused while running; cancel within `timeouts.cancelMs` (+ slack) ending in `stopped` /
`cancelled` and idempotent; abort-signal cancel; idempotent cleanup (running, twice, unknown); cost
provenance; and a **canary secret** injected via `secretEnv` that must not appear in any event, result, cost,
probe output or session ref. The factory receives a scenario (`basic`, `long-running`, `approval`); real
adapters map those onto prompts (options.prompts) against a real model in `p3-e2e` or a stub provider.

In this package the kit runs against the fake in four configurations: full capabilities; Pi-like (no
approvals, degraded cancel, slow forced cancel, estimated cost); exec-like minimal (no follow-ups, resume,
approvals or cost); and version drift with policy `allowUnverified`.

## 6. Mapping of the five runtimes onto the contract

| Contract          | OpenHands 1.54.0 (Agent Server, loopback HTTP+WS)                                      | Claude Code (Agent SDK 0.3.296, in-process)                              | Codex 0.162.1 (`app-server`, stdio JSON-RPC)                            | Pi 1.1.0 (`--mode rpc`, stdio JSONL)                                   | OpenCode 1.19.0 (`serve`, loopback HTTP+SSE)                            |
| ----------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| transport helper  | `startLoopbackServer` (`OH_SESSION_API_KEYS_0`, `--host 127.0.0.1`, `X-Session-API-Key`) | none in-process (SDK spawns the CLI); tree ownership open, see gaps | `spawnOwnedProcess` + `JsonlTransport` + JSON-RPC codec generated from the pinned schema | `spawnOwnedProcess` + `JsonlTransport` + Pi codec (`{type,id}` / `response`) | `startLoopbackServer` (`OPENCODE_SERVER_PASSWORD`, Basic auth, anon probe `GET /global/health` ⇒ 401) |
| probe             | `GET /server_info.version`                                                             | SDK package version / CLI version                                        | `codex --version`                                                       | `pi --version`                                                         | `opencode --version`                                                    |
| spawn             | start server, create conversation (client-supplied id)                                 | `query({cwd, permissionMode, settingSources: [], env})`                  | `thread/start {cwd, sandboxPolicy}`                                     | spawn `pi --mode rpc --offline --no-approve --session-dir --session-id` | start server, `POST /session` with full `permission`                   |
| sendPrompt        | `POST …/events {run:true}`                                                             | push to input iterable / `streamInput`                                   | `turn/start`, follow-up `turn/steer`                                    | `prompt`, `steer`/`follow_up`                                          | `prompt_async`                                                          |
| events            | WS `/sockets/events/{id}` (+ `/events/search` backfill)                                | iterate `SDKMessage`                                                     | notifications (`item/*`, `turn/*`)                                      | event lines; `agent_settled` ⇒ terminal                                | `/event` SSE, `session.idle`                                            |
| requestApproval   | `respond_to_confirmation`                                                              | resolve pending `canUseTool`                                             | answer server request via `respond()`                                   | our permission-gate extension (`extension_ui_request`)                 | `/permission/{id}/reply`                                                |
| cancel            | `pause` / `interrupt` → tree kill                                                      | `interrupt()` → `close()` → tree kill                                    | `turn/interrupt` → tree kill                                            | `abort` → tree kill                                                    | `/session/{id}/abort` → tree kill                                       |
| resume            | `pause` then `run` (same server)                                                       | `options.resume` (same worker)                                           | `thread/resume`                                                         | `--session-id` respawn                                                 | re-prompt same `sessionID`                                              |
| collectResult     | `agent_final_response` + `git/diff`                                                    | `SDKResultMessage` + worker git diff                                     | turn completion + `turn/diff/updated`                                   | `agent_settled` + worker git diff                                      | messages + `/session/{id}/diff`                                         |
| getCost           | `accumulated_cost` → `reported-by-runtime`                                             | `total_cost_usd` → `reported-by-runtime`                                 | tokens only → `estimated-from-tokens`                                   | `get_session_stats.cost` → `reported-by-runtime`                       | `Session.cost` → `reported-by-runtime`                                  |
| repo-config guard | per-job settings; repo loosening U                                                     | `settingSources: []`, explicit `permissionMode`, bypass disabled         | explicit per-turn `sandboxPolicy`/approval policy; repo config U        | `--no-context-files` for untrusted, `--no-extensions -e <gate>`        | `OPENCODE_DISABLE_PROJECT_CONFIG=1` + full `OPENCODE_PERMISSION`        |

### Per-runtime gaps (to be carried as `unverified`/`degraded` until contract-tested)

- **All:** `safe_cancel` is U everywhere ⇒ `unverified` (or `degraded` with reason once our tree kill is
  verified on that OS); resume after restart / on another worker is U.
- **OpenHands:** host-native has no sandbox; Windows native U; token-level streaming U; `/openapi.json` is
  served without auth, so the anonymous probe must target an `/api/*` route; the server binds 0.0.0.0 when a
  key is set unless `--host 127.0.0.1` is passed explicitly.
- **Claude Code:** the SDK owns its CLI subprocess, so the worker cannot use `spawnOwnedProcess` directly.
  `p3-adapter-claude-code` must either verify (against the pinned 0.3.296 typings) an SDK option that lets
  the worker start the CLI itself, or run the SDK inside an owned child process created with
  `spawnOwnedProcess`; until then `safe_cancel` is `unverified`. `artifacts` is
  worker-provided. Native Windows has no sandbox.
- **Codex:** monetary cost unsupported (estimate from tokens); `app-server` is labelled experimental; the
  exec fallback has no approvals and no live multi-turn (exactly the "minimal" fake configuration).
- **Pi:** no native approvals (our extension provides them ⇒ the adapter reports `approval` only when the
  extension is loaded); no sandbox; no protocol-version handshake ⇒ strict Zod schemas + `onBadLine: 'fail'`.
- **OpenCode:** mid-run cancel U; streaming payloads U; no pause; route allowlist needed (PTY/auth/config
  routes blocked) — belongs in the adapter's HTTP client.

## 7. Security review

- **Process tree (ADR-0012 rule 4).** POSIX children start as process-group leaders; `terminate` signals the
  whole group and always ends with a group SIGKILL, also when the leader already exited (orphan reaping).
  Verified on macOS arm64 with a real child + grandchild (both die, including a grandchild that ignores
  SIGTERM). Limits: a descendant that calls `setsid`/double-forks leaves the group — containment for that is
  the dedicated OS user / container (`p3-sandbox`, ADR-0007). A group signal failing with `EPERM` is treated
  as "nothing left" (macOS reports EPERM for a zombie-only group; found as a test flake); a setuid
  descendant in the group would also produce EPERM and survive — the sandbox user must have no setuid
  escalation path (`p3-sandbox`). `pid <= 1` is refused (would signal every
  process). **Windows:** `taskkill /T /F` is unit-tested with a fake runner only (**UNVERIFIED** on Windows);
  `/T` cannot reach descendants whose parent already exited. **Planned improvement:** Job Objects with
  kill-on-job-close via a small native helper — blocking item for `p3-sandbox` / the Windows A-RT checks.
- **Secrets via env only (ADR-0006).** `SecretValue` hides the value from `JSON.stringify`, `String()`,
  template literals and `util.inspect`; only the process helper calls `reveal()` to build the child env.
  Argv containing a secret is refused (`ps` exposure). Child env is built from an allowlist; the worker's own
  credentials are not inherited. Captured stdout/stderr tails are redacted. The contract kit's canary test
  enforces "no secret in events/results/cost/probe". Remaining risk: a runtime can still print a key in its
  own logs/transcripts — full output redaction is `p3-secrets-worker`.
- **Fail-closed local servers (ADR-0012 rule 2).** Loopback-only port, random per-job secret, authenticated
  readiness, then a mandatory anonymous-request check; any non-refusal (e.g. 200) kills the server and raises
  `UnsafeServerError`. Port selection has a TOCTOU window; a collision fails readiness and the caller
  retries. The helper does not verify the bind address; adapters must pass an explicit loopback host flag.
- **Repository config override (ADR-0012 rule 3, ADR-0010).** `SpawnContext.repoConfig` is a required field
  whose only legal value is `'ignore-repository-config'` (checked at runtime too). Each adapter must translate
  it into the runtime-specific switches in §6 and its contract tests must include a repo fixture that tries to
  loosen permissions.
- **Untrusted input from runtimes.** JSONL lines are size-bounded and schema-validated; queues are bounded
  (overflow is fatal, never silent drop); event retention is bounded with explicit cursor expiry.
- **Approvals.** The fake (and the contract for real adapters) denies on approval timeout or missing approval
  channel — never auto-approve.

## 8. Proposed protocol changes (not applied here)

1. Add `safe_cancel` to `Capability` (currently local `LOCAL_CAPABILITIES`).
2. Carry the session outcome on the terminal status (`status: stopped` + `outcome: succeeded|failed|cancelled`)
   so masters need not wait for JOB_RESULT to render it.
3. Export `OsFamily`/`Arch` inferred types (`type OsFamily = z.infer<…>`) like the other enums.
4. Optional `reason` on `RuntimeCapabilities.capabilities[*]` is named `note`; consider `reason` for parity
   with ADR-0008 wording (cosmetic).

## 9. Rollback, operations

New package with no consumers yet; rollback = revert the commit. Operational metrics to wire in `p6-otel`:
cancel latency and mode (graceful/forced/timeout), `UnsafeServerError` count, transport protocol errors by
code, cursor-expiry count.
