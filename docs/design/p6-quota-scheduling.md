# Design note: quota scheduling — usage-limit pauses, fallback runtimes, off-peak windows (P6)

- **Status:** Implemented
- **Date:** 2026-10-16
- **Backlog:** `p6-quota-scheduling` ([p6-efficiency.md](p6-efficiency.md))
- **Builds on:** [p4-quotas.md](p4-quotas.md) §7 (provider pauses, `provider_paused`), [p4-orchestration.md](p4-orchestration.md)
  (dispatch, admissions), [p6-automations.md](p6-automations.md) (ADR-0024), [p6-smart-routing.md](p6-smart-routing.md)
  (outcome scoring — unchanged, applied per runtime option).
- **Decisions applied:** ADR-0014 §5 (a usage limit pauses that runtime on that worker/account until reset, clamped),
  ADR-0011 (additive protocol fields), ADR-0004 (immutable job spec; the attempt records what it ran with), ADR-0009
  (admin + step-up for settings).

## 1. Problem

Live use (one Windows worker, Claude Code + OpenCode on subscriptions) showed that a subscription limit stops all
work: every job sent to the runtime fails, nothing says when it can run again, and nothing tries another runtime.
Cheap batch work also competes with interactive work during the day.

## 2. Usage-limit detection (adapters, worker)

`packages/agent-adapters/src/usage-limit.ts` (pure): `usageLimitFromError(code, text, now, zone?)`,
`claudeRateLimitSignal(info)`, `parseResetTime(text, now, zone?)`, `UsageLimitTracker`.

| Runtime | Signal | Reset |
| --- | --- | --- |
| Claude Code | SDK `rate_limit_event` with `rate_limit_info.status: "rejected"` (and no usable overage) — sdk.d.ts 0.3.296; assistant `error: "rate_limit" \| "billing_error"`; result text ("You've hit your limit · resets 3pm (Europe/Istanbul)", "Claude AI usage limit reached\|<epoch>", "spend limit reached (… resets 2026-08-08 00:00 UTC)") | `resetsAt` (epoch s), else the text in the zone it names, else the worker's zone |
| Codex | `codexErrorInfo` `usageLimitExceeded` / `rateLimitExceeded` (generated protocol, codex-cli 0.162.1) | message "… try again at 3:15 PM." / "… at Oct 17th, 2026 3:15 PM." (worker's local zone, as codex formats it) |
| OpenCode | `session.error` message + provider `responseBody` (`usage_limit_reached`, `insufficient_quota`, `RESOURCE_EXHAUSTED`, …) | `resets_at`, `resets_in_seconds`, `retry-after`, "try again in …" |
| Pi | error events (model errors carry the provider body) via the shared session core | same |

Conservative: a transient 429 the runtime retries ("would exceed your account's rate limit") is not a usage
limit. A reset in the past or > 31 days ahead is dropped (the master then uses its default backoff). When a run ends
`failed` and a signal was seen, the adapter's `errorCode` becomes `provider_usage_limit` and `SessionResult.resetAt`
carries the reset; the worker forwards it as `JOB_RESULT.error.resetAt` (field existed since p4-quotas). Login
failures keep precedence (`login_expired`).

The master side is the p4-quotas pause (`quota_pauses`, scope `worker_runtime` or `account`, clamped to
[now + 60 s, now + maxPauseSec]); it now pauses the runtime the attempt **actually ran** (fallback-aware).
Placement exclusions carry `until` (the pause end); job-level reasons and the job page show "Waiting for quota until
…".

## 3. Fallback runtimes

`JobSpec.fallbacks?: {runtime, model?, modelProfile?}[]` (1–3, distinct, ≠ `runtime`; additive, master-only). The
master resolves each fallback's catalog profile at submission like the job's own (smart-routing role included);
a submitter's `modelProfile` is never trusted. Workflow `defaults`/nodes take `fallbacks` and `deferrable`
(a node's own runtime is dropped from the inherited list); automation job targets carry them in their spec; the
composer has "Fallback runtimes" (tick order) and chat drafts show "Fallback: codex → pi".

Dispatch (`Orchestrator.#dispatch`) tries options in order — admissions, placement (with smart-routing outcomes) per
option — and assigns the first that places. Pure rules in `packages/scheduler/src/fallback.ts`:

- the next option is tried when the current one is not placed **and no machine is merely busy with it**
  (`no_free_slot` only): paused, not installed, not logged in, not enabled, unusable profile or offline machines let
  the fallback run; a free slot soon is waited for;
- a job-level hold falls through only when every reason is runtime-level (`runtime_concurrency`); project holds,
  budgets, dependencies and the off-peak deferral hold the job whatever its runtime;
- infeasible only when every option's placement is infeasible; otherwise the job waits with all options' reasons
  (fallback reasons prefixed "fallback <runtime>:").

The ASSIGN_JOB spec is the chosen option's plain spec (`fallbacks`/`deferrable` stripped, no primary
`runtimeVersion`), so workers need no change. `job_runs.runtime_choice` = `{index, runtime, model?, modelProfile?,
reason?}` (reason: "claude-code: provider_paused until … [w1]"); the job page says "Ran with the fallback runtime …".
Queries that need the runtime of an attempt use `COALESCE(runtime_choice->>'runtime', spec->>'runtime')`: provider
pause scan, concurrency counting, usage attribution (runtime and model), follow-up messages, the live terminal view
and memory samples. Known limitation: skills and the context bundle are pinned for the job's own runtime (both are
runtime-neutral instructions in practice); metrics and list filters show the declared runtime.

## 4. Off-peak windows

`projects.off_peak = {start: "HH:MM", end: "HH:MM", timeZone: IANA}` (start ≠ end; start > end crosses midnight).
Wall-clock in the zone, so DST is followed (`@remyral/protocol` `zoned-time.ts`: `Intl` zone rules; a skipped
wall time resolves forward, a repeated one to the earlier instant; a start inside a spring-forward gap opens at the
transition). `JobSpec.deferrable` (jobs, automation job targets, workflow steps). The `QuotaSchedulingService`
admission (before quotas) holds a deferrable job of a project with a closed window: QUEUED, reason
`deferred_off_peak` with `until` = next start. No window → runs at once. "Run now" (`job_run_now`, first request
wins) admits it. Once started, a job runs to completion past the window end; one not placed before the window
closes waits for the next window.

## 5. Data (migration 0052, additive)

`job_runs.runtime_choice jsonb`, `projects.off_peak jsonb` (+ `off_peak_updated_by/at`), `job_run_now` (FK jobs, one
row per job). Rollback: revert the code; the columns/table are ignored by older code.

## 6. API

| Route | Action | Notes |
| --- | --- | --- |
| `GET /projects/:id/off-peak` | `projects.execution.read` | window, open now, next start |
| `PUT /projects/:id/off-peak` | `projects.execution.write` + step-up | `{window: {start,end,timeZone} \| null}`; audited `project.off_peak.update` |
| `POST /jobs/:id/run-now` | `jobs.create` (job's project) | 409 `not_deferrable` / `not_queued`; audited `job.run_now` |
| `GET /jobs/:id` | (existing) | `orchestration.schedule.reasons[].until`, `runs[].runtimeChoice`, `runNow` |

## 7. UI

Job page: "Waiting for quota until <time>" (warn), "Deferred to the project's off-peak window — starts at <time>"
with **Run now**, "Ran with the fallback runtime … : <reason>". Projects → Policy → Off-peak window (admins edit with
step-up). Composer → Where → Fallback runtimes / Off-peak. Chat drafts: Fallback and When lines.

## 8. Tests

- `packages/agent-adapters/test/usage-limit.test.ts` (18): texts of the pinned claude/codex binaries and provider
  bodies, negatives (transient 429, overloaded), reset parsing (zones, dates, epochs, JSON, durations, implausible),
  Claude mapper (rate_limit_event, assistant error, result), Codex error, OpenCode session.error, session core.
- `packages/protocol/test/zoned-time.test.ts`: conversion, spring-forward gap, fall-back overlap, validation.
- `packages/scheduler/test/fallback.test.ts`: option order, paused/not-installed fall through, busy waits, holds,
  pause `until`, combined reasons.
- `apps/worker/test/job-runner.test.ts`: `provider_usage_limit` + `resetAt` in JOB_RESULT.
- `apps/master/test/unit/quota-scheduling.test.ts`: windows across midnight, east/west zones, DST both ways, start in
  a gap; option specs, worker spec stripping, protocol refinement.
- `apps/master/test/integration/quota-scheduling.test.ts` (real master + worker daemons + fake runtimes): not
  installed → fallback; usage limit → pause until the reported reset, a plain job waits with `until`, a fallback job
  runs on pi with the reason; invalid fallback list 400; off-peak hold with `until`, Run now (audited, 409 cases),
  open window runs at once.
- `apps/web/test/quota-scheduling.test.tsx`: parsing, queue notice texts, Run now request, fallback notice as text,
  composer spec, chat draft lines, window checks. Route coverage lists the three routes.

## 9. Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| T-WRK-3 compromised worker pauses runtimes | Unchanged from p4-quotas: one pause per report, only its own runtime/account, clamped to `maxPauseSec`, admins resume early. `resetAt` is a timestamp only; text never reaches pause reasons. | A worker can claim limits on every run (bounded as before). |
| Fallback escalation | Fallbacks pass the same submission checks (RuntimeKind, retired runtimes refused, distinct); each option goes through every admission and placement filter (sandbox, approval policy, secrets, runtime policy) — a fallback can never run where the job itself could not, except for the runtime. Profiles resolved by the master. | A fallback runtime has its own capabilities/approval behaviour; the job author chose it. |
| Off-peak misuse | Window change: project admin + step-up, audited with before/after. Run now: operators of the job's project (who could submit it now anyway), audited, idempotent. | — |
| Information leakage | Reasons and runtime choice are built from codes, worker ids and times; worker/provider text is not stored in them; the UI renders text only. Adapter limit text is already redacted. | Worker ids visible to job viewers (as before). |
| Parsing untrusted text | Regexes are bounded (64 KiB tail, anchored lengths), no catastrophic patterns; zones validated via `Intl` and a name regex. | — |

## 10. Operations and rollout

Deploy the master first (migration 0052), then release the worker (detection lives in the adapters; older workers
keep reporting generic failure codes, so pauses only come from the fake runtime / new workers). Signals:
`quota_events`, `quota_pauses`, `job_schedule_status` reasons `provider_paused`/`deferred_off_peak`, log line
`job dispatched with a fallback runtime`, audit `job.run_now`, `project.off_peak.update`.

## 11. UNVERIFIED

Limit messages on live accounts (Claude Max/Pro window, ChatGPT Codex plan, OpenCode/Pi providers): detection is
tested on the strings the pinned binaries contain and on documented provider bodies; the first real limit should be
checked on the job page (expect "Waiting for quota until …" with the right time). Codex prints the reset in the
worker's local time zone; a worker whose process zone differs from the machine's would shift it (the master clamps).
