# p11-usage-limit-fallback — usage limits wait or fall back, never just fail

- **Task:** `p11-usage-limit-fallback`. **Date:** 2026-10-18.
- **Owner request:** "saat limitleriyle ilgili de fallback mekanizması yapılsın" — the runtimes' usage / time limits
  (Claude Code subscription 5-hour session and weekly limits, Codex plan limits, API-key rate limits, OpenCode / Pi
  provider limits) must not end jobs FAILED or leave the chat assistant erroring.
- **Decision:** [ADR-0040](../adr/0040-usage-limit-wait-or-fallback.md).
- **Builds on:** [p6-quota-scheduling](p6-quota-scheduling.md) (limit detection, provider pauses, per-job fallback
  runtimes), [p4-quotas](p4-quotas.md) §7 (`quota_pauses`), [p10-approval-pause](p10-approval-pause.md) (PAUSED,
  parked workspace, resume on the same machine), [p10-claude-login-health](p10-claude-login-health.md) (login vs.
  limit), [p9-queue-local-login-accounting / p9-subjob-local-login](p9-subjob-local-login.md) (login stores),
  ADR-0018 / ADR-0025 (assistant engines).
- **Migration:** 0088 (0087 = p11-master-resilience, 0089 = p11-merge-pipeline). **Worker release:** yes
  (`usage-limit-park-v1`, typed limit info, assistant detection). **Protocol:** additive in 1.0.

## 1. What happens today (findings, 2026-10-18)

| Piece | Behaviour | Where |
| --- | --- | --- |
| Detection | Already present since p6: Claude SDK `rate_limit_event` (`status: rejected`, `resetsAt`), assistant errors `rate_limit` / `billing_error`, CLI texts; Codex `codexErrorInfo` `usageLimitExceeded` / `rateLimitExceeded` + "try again at …"; OpenCode / Pi provider bodies. The adapter's `errorCode` becomes `provider_usage_limit` with `SessionResult.resetAt`. **No scope** (subscription / API key / one model) and no limit kind (5-hour, weekly, Opus weekly, spend cap). | `packages/agent-adapters/src/usage-limit.ts` |
| Job | JOB_RESULT `failed` + `provider_usage_limit` → `attempt_failed` → **FAILED** (terminal). The work done so far is lost with the released worktree. | `orchestration/inbox.ts` |
| Scheduler | `scanProviderLimits` pauses the runtime on that worker (or the configured provider account) until the reset (clamped to `maxPauseSec`): other jobs wait with `provider_paused until …`; jobs with `spec.fallbacks` use the next runtime. One `quota_events` row + notification **per reporting job** (three jobs hitting one limit = three notices), none when it resets. | `quotas/service.ts`, `packages/scheduler/src/quotas.ts` |
| Fallback | Only per job (`spec.fallbacks`, p6), distinct runtimes; no project policy, no "same runtime with an API-key credential", no paid-cost guard. | `quota-scheduling/runtime-options.ts` |
| Chat assistant | The assistant engines do not run the limit detection: a limit ends the turn as `error_during_execution` / `turn_failed` / `model_error`, the chat shows "The assistant failed (…)". The user message is kept, but nothing tells when it works again and there is no other engine. | `runtimes/*/assistant.ts`, `chat/service.ts` |

## 2. Detection — a typed `usage_limited` outcome (adapters, worker)

`usage-limit.ts` gains the typed outcome and the classifier:

```ts
type UsageLimitScope = 'subscription' | 'api_credential' | 'model';
type UsageLimitKind = 'session' | 'weekly' | 'model_weekly' | 'spend' | 'quota' | 'rate';
interface UsageLimitSignal { resetAt?: Date; kind?: UsageLimitKind; modelScoped?: boolean; model?: string }
classifyProviderFailure(code, text, now, zone?) → { class: 'usage_limited', signal } | { class: 'auth' } | { class: 'transient' } | null
```

- **Usage limit** (as before plus): Claude `rateLimitType` `five_hour` → session, `seven_day` → weekly,
  `seven_day_opus` / `seven_day_sonnet` → model_weekly (model-scoped), `overage` → spend (sdk.d.ts 0.3.296
  `SDKRateLimitInfo`, confirmed with the Agent SDK reference via Context7); Codex "You've hit your usage limit for
  <model>. Switch to another model now, or try again at …" → model-scoped, "You hit your spend cap …" / "Your workspace
  is out of credits" → spend (codex-rs `UsageLimitReachedError` Display, Context7); CLI "Opus weekly limit reached"
  → model-scoped; `Retry-After` as seconds **or** an HTTP date.
- **Auth** (never a limit): 401 / `authentication_failed` / invalid API key / OAuth token expired → stays
  `login_expired` (p10-claude-login-health keeps precedence).
- **Transient** (never a limit): 5xx, `overloaded` / 529, connection resets, plain "rate limit, retrying" — the runtime
  retries those itself; a run that still ends on them fails as before.

The worker turns the adapter's signal into `JOB_RESULT.error.usageLimit` (additive):
`{scope, kind?, model?, store?, message?}` — `scope` = `model` when model-scoped, else `subscription` when the
runtime ran with the worker's local login (and no job credential), else `api_credential`; `store` = the login store
(`localLogin.stores`); `message` = the runtime's text, redacted, one line, ≤ 300 characters. `resetAt` stays where it
was (`error.resetAt`).

## 3. Policy (per project, with a workspace default)

`UsageLimitPolicy` (`@remyral/protocol` `usage-limit.ts`, shared by master and web):

| Field | Meaning | Default |
| --- | --- | --- |
| `mode` | `auto` · `wait` · `fallback` · `fail` | `auto` |
| `maxWaitHours` | `auto`: wait when the reset is at most this far away (0.25–168) | 6 |
| `fallbacks` | ordered `{runtime, model?}` (≤ 4); `model` = a model catalog profile id — **the same runtime with an API-key profile is allowed** (e.g. Claude Code subscription → Claude Code + "Anthropic API key" profile → Codex → OpenCode + a model) | `[]` |
| `allowPaidFallback` | fallbacks that bill per token (a profile with a credential, or a machine whose runtime uses an API key) may run | `false` |

`decideUsageLimitAction(policy, {resetAt, now, fallbackAvailable})` (pure): `fail` → fail; `wait` → wait;
`fallback` → fallback if available else wait; `auto` → wait if the reset is known and ≤ `maxWaitHours`, else
fallback if available, else wait (until the reset, or the provider-pause default backoff when unknown).

Storage: `usage_limit_defaults` (singleton row, Settings → Usage → Enforcement, admin + step-up) and
`projects.usage_limit_policy` (NULL = inherit; Projects → Policy → Usage limits, project admin + step-up). Both
audited (`usage_limit.defaults.update`, `project.usage_limit.update`).

**Effective runtime options of a job** (`UsageLimitService.options`): the job's own spec, then `spec.fallbacks`
(p6, explicit) or — when the job names none and the mode is `auto`/`fallback` — the policy's fallbacks resolved like
a submission (`resolveJobModel`, master-side profiles; never the submitter's). Options equal to the primary
(runtime + profile) are dropped. **Paid guard** (when `allowPaidFallback` is false), for every fallback option
(index ≥ 1): an option whose profile carries a `credentialRef` is dropped; on machines whose CAPABILITIES.localLogin
does not list the option's runtime (it runs with an API key there) the option gets the placement block
`paid_fallback_not_allowed`. Machines that do not report `localLogin` (older workers) are treated as subscription
(residual, §10). Budgets apply to every option as before (admissions run per option).

## 4. When a job hits a limit

```
 JOB_RESULT failed + provider_usage_limit (inbox transaction)
   │  usage_limit_hits row (attempt), usage-limit episode per store (first hit → notification), quota pause (store
   │  scope) — all in the same transaction; audit usage_limit.hit
   │  action = decideUsageLimitAction(effective policy, reset, fallback available?)
   ├─ fail ───────────────▶ attempt_failed → FAILED (old behaviour); a parked workspace is discarded
   ├─ wait / fallback, worker parked (usage-limit-park-v1)
   │      ─▶ pause_confirmed → PAUSED, job_pauses(cause 'usage_limit'):
   │          wait:     status 'paused', resume_at = pause end + jitter (15–90 s, per job)
   │          fallback: status 'resuming' at once, resume_options = fallback list
   │         tick: resume_at ≤ now → 'resuming'; dispatcher "resume-paused": same machine, same attempt (epoch + 1),
   │         option by option (wait: the runtime that hit the limit; fallback: each fallback, then the original);
   │         none placeable on that machine and nothing merely busy → restart elsewhere (PAUSED → QUEUED, the kept
   │         workspace discarded) and the normal dispatcher picks among the options
   └─ wait / fallback, not parked (older worker, park failed)
          ─▶ attempt_retry → RETRY_WAIT (system, retry-safe: a failed run published nothing), requeue_at = wait: pause
             end + jitter, fallback: now; promoteRetries holds the job until requeue_at; the dispatcher then skips the
             paused store (provider_paused) and tries the options in order
```

- **Same workspace.** The parked path keeps the worktree, the attempt branch, the sandbox dir and the runtime session
  (exactly the p10 park). Resume with the same runtime continues the runtime's own session when the `resume`
  capability is offered, else a fresh session with "Earlier progress"; with a **different** runtime (fallback on the
  same machine) always a fresh session of the new runtime in the same worktree with the continuation note. The
  resumed attempt's `job_runs.runtime_choice` is updated to the option it now runs.
- **Note to the agent** (`execution.resume` `{cause: 'usage_limit', runtime, resetAt?, switchedTo?}`): "This run
  stopped because the <runtime> usage limit was reached; it continues now (the limit reset / on <other runtime>).
  Files are as you left them; continue the task."
- **Visible and audited.** Transition reasons: "usage limit on Claude Code (subscription, store claude on w1); waiting
  until 15:00 (resumes in the same workspace)", "usage limit on Claude Code; continued on Codex in the same workspace",
  runtime choice reason on a new attempt. Audit `usage_limit.hit`, `job.usage_limit.wait`, `job.usage_limit.fallback`,
  `job.usage_limit.fail`. Job page: "Waiting for the usage limit to reset — resumes at 15:00 on <machine>" panel
  (Resume now / Restart from scratch / Cancel; the p10 panel with a usage-limit headline), and the fallback notice.
- **Retention.** A usage-limit pause keeps the workspace until `resume_at + 24 h` (≤ 7 d); a resume that could not
  happen by then restarts the job elsewhere (it is never cancelled by the wait). A blocked resume (machine gone,
  kept workspace missing, worker too old) restarts elsewhere at the next tick, too.
- **Admissions on resume.** A resume that may switch runtime runs that option through the dispatch admissions
  (budgets, concurrency): a hold keeps the job parked on its machine (like a busy slot — the budget may be raised)
  instead of restarting it elsewhere or running it over budget.
- **Time.** Paused time (approval or usage limit) no longer counts against the master's wall-time backstop
  (`checkWallTime` subtracts the attempt's pause intervals); the worker's run clock already excluded it.
- **Fix on the way:** an approval resume of an attempt that ran on a fallback runtime now resumes with that runtime's
  spec (before, the primary spec was sent and the worker refused the runtime mismatch).
- **Sub-jobs / automations:** unchanged contracts — a paused child reports `running` with reason
  `paused_usage_limit`.

## 5. Scheduler awareness

- **Store / machine scope** (subscription login or a machine-level API key): the existing `quota_pauses`
  (`worker_runtime`, or `account` when the pair belongs to a configured provider account) — inserted in the inbox
  transaction now, so no dispatch slips in. Placement reason message: "usage limit on <runtime> until <time>".
- **Credential scope** (a model-profile credential, used on any machine) and **model scope** (one model of a store):
  no runtime-wide pause (it would hold unrelated jobs). `UsageLimitAdmission` holds options that use that credential /
  model with `usage_limited` (`until`), and adds worker blocks for model-scoped store limits. `usage_limited` is a
  runtime-level hold: the next option is tried (`RUNTIME_HOLDS`).
- **auto mode for new jobs:** a job whose primary is paused falls through to the **policy** fallbacks only when the
  pause ends later than `maxWaitHours`; otherwise it waits with "usage limit until …" (explicit `spec.fallbacks`
  keep the p6 rule).
- **Episodes** (`usage_limit_episodes`, one open per scope key `worker:<id>:<runtime>[:<model>]`,
  `account:<id>:<runtime>`, `credential:<ref>[:<model>]`): first hit, last hit, hits, reported reset, resume time,
  scope, kind, store, redacted message. `GET /usage-limits/status` (`quotas.read`) lists the open ones; machine cards
  and the machine page say "<runtime>: usage limit reached — resets at 15:00"; Usage → Enforcement lists all
  (credential ones too).

## 6. Notifications

Kinds `usage_limit.reached` and `usage_limit.reset` (outbox topic `usage_limit`), **one per episode** (dedupe
`usage_limit.reached:<episode>` / `usage_limit.reset:<episode>`), to owners/admins and the operators of the project of
the first job: "Claude Code usage limit reached on w1 (subscription) — resets at 15:00; 3 jobs wait / continue on
Codex", "Claude Code usage limit on w1 has reset". A later hit while the episode is open only extends it (no new
notice). The episode ends when its resume time passed (tick) — then the reset notice — or when an admin resumes the
pause early. The old per-pause `quota_events` row stays (Usage history) but no longer notifies by itself.

## 7. Chat assistant

- Engines: every assistant engine runs the same classifier on its failure (Claude: result text, assistant `error`,
  `rate_limit_event`; Codex `codexErrorInfo`; OpenCode / Pi provider errors) and fails the turn with reason
  `provider_usage_limit`, `detail` = the reset and the redacted text; ASSISTANT_UPDATE `failed` gains an optional
  `resetAt`.
- Settings → Chat: optional **fallback engine** (`fallback_runtime`, `fallback_model_profile`; same machine — the
  machine must report it ready).
- On `provider_usage_limit`: the master stores the engine limit (`chat_engine_limits`, runtime + worker → until), adds
  a clear chat line "Claude Code reached its usage limit — it works again at 15:00." and, when a fallback engine is set,
  ready and not limited itself, **re-sends the same user message** as a new turn on the fallback engine ("Continuing
  with Codex.") — the message is never lost (it is stored before the first turn, as before). Until the reset, new
  turns go to the fallback engine directly; without a fallback the chat status says "usage limit until 15:00" and the
  send is refused with that text (409 `assistant_usage_limited`), the user's typed text stays in the box.
- Paid guard: a fallback engine is an admin's explicit choice; the settings page says whether it runs with an API key
  on that machine (cost).

## 8. Data (migration 0088, additive)

- `usage_limit_defaults` (singleton), `projects.usage_limit_policy jsonb`, `projects.usage_limit_updated_by/_at`.
- `usage_limit_episodes`, `usage_limit_hits` (attempt PK → episode, requeue_at, action, decided policy snapshot).
- `job_pauses`: `cause` (`approval` | `usage_limit`, default `approval`), `request_id` nullable (required for
  `approval`), `resume_at`, `usage_limit jsonb`, `resume_options jsonb`.
- `chat_settings.fallback_runtime`, `fallback_model_profile`; `chat_engine_limits`.
- Notification kinds appended to both CHECK constraints by reading the current definition (robust to parallel
  migrations adding kinds).
Rollback: revert the code; the new columns / tables are ignored by older code (a job PAUSED by a usage limit would not
be resumed by older code — restart or cancel such jobs first).

## 9. API

| Route | Action | Notes |
| --- | --- | --- |
| `GET /usage-limits/defaults` | `quotas.read` | workspace default policy |
| `PUT /usage-limits/defaults` | `quotas.write` + step-up | audited `usage_limit.defaults.update` |
| `GET /projects/:id/usage-limit-policy` | `policy.read` | own policy (null = inherit), effective policy, fallback options with `paid` and an estimated cost per job (last 30 days of this project's usage of that runtime / model, API-key records) |
| `PUT /projects/:id/usage-limit-policy` | `policy.write` + step-up | `{policy: … \| null}`; audited `project.usage_limit.update` |
| `GET /usage-limits/status` | `quotas.read` | open episodes (store / credential / model) |
| `GET /jobs/:id` | (existing) | `pause.cause`, `pause.usageLimit`, `pause.resumeAt` |

## 10. Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Paid runs without consent (cost) | Fallbacks to API-key profiles are dropped and API-key machines blocked (`paid_fallback_not_allowed`) unless the project (or default) sets `allowPaidFallback` (admin + step-up, audited). Budgets hold every option as before; the policy card shows the estimated cost per job. | Workers that report no `localLogin` are treated as subscription machines. |
| A compromised worker fakes limits (T-WRK-3) | As p4/p6: only its own runtime / store is paused, clamped to `maxPauseSec`; a wait parks only its own attempt; a fake `scope` can at most pause a credential for the clamp (credential scope requires the job to carry that credential). Text never reaches reasons other than the bounded, redacted `message` shown as text. | A worker can still make its own jobs wait. |
| Fallback escalation | A fallback option passes every admission and placement filter of a normal dispatch (sandbox, approval policy, secrets, runtime policy, project policy); profiles resolved by the master. Resume with another runtime keeps the attempt's spec except the runtime / model profile. | The fallback runtime has its own capability matrix (documented). |
| Untrusted text to the agent | The continuation note carries only runtime names, times and master-built text; the limit message is not given to the agent. | — |
| Repudiation | Hits, decisions, fallbacks, policy changes audited; transitions in the append-only history. | — |
| Notification flood | One notice per episode and store, one on reset. | — |
| Parsing untrusted text | Bounded regexes (64 KiB tail), `Intl`-validated zones, implausible resets dropped (past, > 31 days). | — |

## 11. Tests

- Adapters: `packages/agent-adapters/test/usage-limit-typed.test.ts` (real-ish texts per runtime: Claude
  `rateLimitType` five_hour / seven_day / seven_day_opus / seven_day_sonnet / overage, CLI 5-hour / weekly / Opus
  weekly texts; Codex "try again at" / "try again in 2h 14m" / usage limit for one model / spend cap / out of credits;
  OpenCode `usage_limit_reached` body; Pi 429 quota + `Retry-After` seconds and HTTP date; the session core's typed,
  redacted detail; login and transient negatives; tracker accumulation; the assistant mapping) and the updated
  `usage-limit.test.ts`.
- Protocol: `packages/protocol/test/usage-limit.test.ts` (decision rule, policy schema and bounds, jitter, credential
  keys, JOB_RESULT `usageLimit` / `paused{cause}`, resume union, `execution.usageLimitPark`, feature).
- Worker: `apps/worker/test/usage-limit-park.test.ts` (park with the flag: failed + typed limit + paused, workspace and
  record kept; without the flag released as before; resume with the same runtime continues its session; resume on a
  fallback runtime starts a fresh session in the kept worktree with earlier progress; an approval resume still refuses
  another runtime).
- Master integration (real Postgres, real worker daemons over WebSocket, fake runtime, fake clock):
  `apps/master/test/integration/usage-limit-fallback.test.ts` — two jobs hit one store → PAUSED, one episode with two
  hits, one notification, status API, a new job held with `provider_paused`; at the reset both resume (same attempt,
  same machine), the third runs, one reset notice, audit trail; policy fallback continues on pi in the same workspace
  (runtime choice `origin: policy`, transition reason, hit `fallback/parked`); an older worker → RETRY_WAIT held until
  the reset then a new attempt, and a fallback requeue onto pi at once; paid guard (API-key profile skipped → wait) and
  budget guard (fallback over budget → waits with `budget_exceeded`); policy API (inherit / own / step-up / validation /
  workspace default, audited). `chat-engine-fallback.test.ts` — the limited engine's message is answered by the
  fallback engine (one user message, error line with the reset, audit), later turns go there directly, back to the
  main engine after the reset; without a fallback: error line, status `engine_limited`, 409 `assistant_usage_limited`.
  Updated: `quota-scheduling.test.ts` (the limited job now waits), `quotas.test.ts` (runs with default `fail` to keep
  covering the p4 pause itself).
- Web: `apps/web/test/usage-limit-fallback.test.tsx` (policy card: inherited default, own policy with ordered
  fallbacks, paid opt-in warning, step-up, cost estimate, skipped paid fallback, bound check, viewer; job page panel
  for a usage-limit pause; fallback notice from the policy; machine card note; reason texts; limits line; chat status
  parsing); updated `fleet.test.tsx`.

## 12. Rollout

Master first (migration 0088), then the worker release (park on limit, typed info, assistant detection). Older
workers: limits still detected as before; jobs go RETRY_WAIT (new attempt) instead of PAUSED; chat limits look like
before (no fallback trigger) until the worker is updated.

**UNVERIFIED (needs real accounts):** the exact texts / events of a live Claude Max 5-hour and weekly limit, a ChatGPT
Codex plan limit and provider 429s on the fleet; resume of a real session after a limit wait.
