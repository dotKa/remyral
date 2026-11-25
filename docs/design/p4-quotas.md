# Design note: quotas — concurrency limits, fairness, run budgets, provider pauses, kill switch (P4)

- **Status:** Implemented
- **Date:** 2026-10-13
- **Backlog:** `p4-quotas` — "Concurrency limits, fairness, run budgets, provider quotas, runaway stop"
  (acceptance **A-ORCH-2**: per-worker and provider concurrency/budgets enforced).
- **Decisions applied:** ADR-0014 §5 (subscription runs budgeted by tokens/turns/time; `provider_usage_limit`
  pauses that runtime on that worker until reset), ADR-0008 (cost provenance; unknown is never zero),
  ADR-0003/0004 (Postgres is the truth; decisions re-read it; cancellation through CANCELLING + durable
  CANCEL_JOB), ADR-0009 (privileged writes: admin + step-up), ADR-0011 (additive protocol fields).
- **Builds on:** [p4-orchestration.md](p4-orchestration.md) (dispatch, placement, cancel),
  [p6-cost.md](p6-cost.md) (`evaluateBudget`, unknown-cost semantics, `usage.budget.threshold`),
  [p5-rbac.md](p5-rbac.md), [p5-notifications.md](p5-notifications.md).
- **Threat model:** T-OPS-2 (runaway agent spends budget), T-OPS-3 (repudiation), T-WRK-3 (compromised worker
  floods/forges), T-CP-3 (privilege misuse).

## 1. Shape

```
packages/scheduler/src/quotas.ts     pure: QuotaPolicy, effectiveJobLimits, checkJobLimits, concurrencyHolds,
                                     workerQuotaBlocks, pauseUntil, fairOrder (+ placement: quotaBlocks)
packages/protocol                    JobSpec.limits.{maxTokens,maxTurns}; JOB_RESULT.error.resetAt (optional)
apps/master/src/quotas/              policy.ts (zod), store.ts (QuotaStore), service.ts (QuotaService),
                                     effects.ts (QuotaEffects), outbox.ts (quota.enforcement), routes.ts
apps/master/src/orchestration/       orchestrator.ts: DispatchAdmission + TickStep extension points (additive)
apps/master/migrations/0017_*.sql    quota_policies, quota_pauses, quota_project_holds, quota_events
apps/web                             Usage → Enforcement tab; Fleet shows provider pauses per worker
```

The orchestrator gained two additive extension points so quota (and DAG) logic lives outside it:

- `admissions: DispatchAdmission[]` — consulted **under the dispatch advisory lock** before placement:
  `hold(reasons)` keeps the job QUEUED with waiting reasons (stored in `job_schedule_status`, shown by
  `GET /jobs/:id`), `skip` means the admission moved the job itself, `admit(adjust)` narrows candidate
  workers by adding transient `quotaBlocks` to them. One admission may define `order()` for the pass.
- `steps: TickStep[]` — extra reconciliation steps run by `tick()` before dispatch.

## 2. Concurrency limits

| Limit | Where configured | Counted from |
| --- | --- | --- |
| per worker | worker `maxParallelJobs` (CAPABILITIES, existing) | master's unreleased leases |
| per project | policy `projects.<id>.maxConcurrent` | jobs in attempt-open states (RESERVED, STARTING, RUNNING, VERIFYING, CANCELLING, LOST) |
| per runtime (fleet-wide) | policy `runtimes.<runtime>.maxConcurrent` | same, by `spec.runtime` |
| per provider account | policy `accounts[] {id, runtime, provider?, maxConcurrent?, workers[]}` | same, runtime = account runtime and current attempt on any member worker |

A subscription account shared by several workers **counts once**: its active jobs are summed over every
member (worker, runtime) pair; a (worker, runtime) belongs to at most one account (validated). LOST counts
as active (it may still run). Project/runtime limits are job-level holds (`project_concurrency`,
`runtime_concurrency`); account limits are worker-level exclusions (`account_concurrency`, transient) so the
job can still go to a worker outside the account.

## 3. Quota policy

One versioned JSON document (`quota_policies`, append-only, `version = max + 1` by trigger; no row = built-in
defaults: no limits, `incomplete: warn`, `onExceeded: refuse_new`, pause 15 min default / 24 h max, aging
60 s, fairness window 600 s). `PUT /quotas/policy {expectedVersion, policy, note?}` (admin, step-up) validates
strictly (zod, unknown keys rejected; ids/runtime/provider by regex; bounded sizes) and answers 400 with
paths/codes only, 409 on a stale version. Audited `quota.policy.update` with counts only.

## 4. Fairness

`fairOrder` (pure) orders a dispatch pass: weighted fair share across projects with aging inside a project.

- Within a project: effective priority (`priority + ⌊wait / agingSec⌋`), then age.
- Across projects: the next job comes from the project with the lowest `(load + picked) / weight`, where
  `load` = the project's active jobs + jobs it started (`reserve`) in the fairness window. Every start raises
  the share, so a heavy or high-priority project cannot starve a light one; a project cannot buy precedence
  over another project with `priority` (priority orders within a project). Ties: higher effective priority,
  older head job, project id.
- `dispatchQueued` reads up to 10× the pass limit of queued jobs, orders them fairly and dispatches the first
  `limit`.

**Limits of the guarantee:** fairness applies to the order in which a pass offers free capacity. A slot that
frees *during* a pass (or a new worker's capabilities arriving mid-pass) may go to a later job of that pass;
per-job dispatches from outbox hints and `POST /jobs` try only that job. Both are compensated by the fairness
memory (the winner's share rises). Tests: unit "no starvation" (a flood of high-priority jobs of one project
vs. one low-priority job of another: served at its next start), integration with a test-driven loop (a freed
slot goes to the other project, the higher-priority backlog keeps waiting).

## 5. Run limits and runaway stop

Per-job limits = the smallest of `JobSpec.limits` (`maxCostUsd`, new optional `maxTokens`, `maxTurns`,
`maxDurationSec` as per-attempt wall time), the project's `jobLimits` and the policy's global `jobLimits`
(defaults can only narrow a job). Checked:

- **on every usage event**: `QuotaEffects` wraps the integration-glue effects; after `UsageStore.recordUsage`
  the job's consumption (`UsageStore.consumption({jobId})` — tokens = input + output, turns, known dollars
  with the current price table and the coverage flags) is checked with `checkJobLimits`;
- **every tick** for wall time (`quota-wall-time`, master-side backstop; the worker enforces
  `maxDurationSec` itself).

Exceeded → `cancel_requested` by `system:quota` with reason `budget_exceeded: <metric> <used> reached the job
limit <max>` → CANCELLING + durable `CANCEL_JOB` (same reason) → the worker aborts the runtime →
`cancel_confirmed`. Idempotent: a second event finds the job CANCELLING (illegal transition, ignored). Each
stop is recorded once in `quota_events` (`job_stopped`) and announced (`quota.enforcement` outbox →
p5-notifications, project operators).

**Unknown/incomplete figures (p6-cost semantics):** a known lower bound at/over the limit is exceeded even
with gaps. Below the limit but incomplete (unknown-cost records for dollars; records without
tokens/turns) is never "under": policy `budgets.incomplete` decides — `warn` (default: continue, record
`incomplete_cost` once per job/limit, notify) or `block` (stop with `budget_incomplete`).

## 6. Scope budgets (p6-cost budgets) before dispatch

Admission evaluates every enabled budget covering the job's project/runtime (and the global ones):
`over` → hold with `budget_exceeded` and an actionable message ("budget "X" (project acme, tokens/day) is at
105 %; new jobs wait until the window resets or the budget is raised"); `unknown` → policy (`block` → hold
`budget_incomplete`; `warn` → admit, record and notify once per budget window). Worker- and provider-scoped
budgets exclude only those workers (provider = the account's `provider` of that worker/runtime). The job is
held, not failed: it dispatches when the window rolls over or an admin raises/removes the budget. Policy
`budgets.onExceeded: stop_running` also stops running jobs whose scope budget is over (checked on their usage
events); default `refuse_new`.

## 7. Provider usage limits (ADR-0014 §5)

A JOB_RESULT failed with `error.code = provider_usage_limit` (optional new `error.resetAt`) → the
`quota-provider-limits` step (also run inside admission, so no dispatch slips in between) inserts **one pause
per report** (`quota_pauses.source_attempt_id` unique): scope `account` when the (worker, runtime) belongs to
a provider account, else `worker_runtime`. `resume_at` = the reset time clamped to [now + 60 s, now +
`maxPauseSec`], else now + `defaultBackoffSec` — a worker cannot pause more than its own runtime/account for
longer than the policy allows. Paused pairs are excluded from placement (`provider_paused`, transient, with
the resume time). Visible in `GET /quotas/status`, Usage → Enforcement and Fleet (per worker). An admin can
resume early (`POST /quotas/pauses/:id/resume`, step-up; audited `quota.provider.resume`). The failed job
itself stays FAILED (no blind rerun; a workflow node may retry by policy, p4-dag). The fake runtime's `crash`
step accepts a `code` to emulate it.

## 8. Kill switch

`POST /projects/:id/kill {reason, hold=true}` (action `projects.kill`: project-scoped admin, step-up, CSRF):
every non-terminal job of the project gets `cancel_requested` by the user with reason `kill_switch: …`
(executing jobs → CANCELLING + CANCEL_JOB; queued/blocked/awaiting → CANCELLED; LOST → CANCELLING, confirmed
by the reconciler). With `hold`, `quota_project_holds` refuses dispatch of the project (`project_hold`) until
`DELETE /projects/:id/kill` (same action, step-up). Kill hooks let p4-dag cancel the project's workflow runs.
Audited `project.kill` (counts, hold) / `project.kill.release`; denials audited by the authorization layer.

## 9. REST and console

| Route | Action (p5-rbac) | Notes |
| --- | --- | --- |
| `GET /quotas/status` | `quotas.read` (global viewer) | policy, projects (visible only), runtimes, accounts, active pauses (+ covered workers), holds (visible), budgets with enforcement, recent decisions (visible) |
| `PUT /quotas/policy` | `quotas.write` (admin) + step-up | `expectedVersion` |
| `POST /quotas/pauses/:id/resume` | `quotas.write` + step-up | 404 when not active |
| `POST /projects/:id/kill` | `projects.kill` (project admin) + step-up | 404 for unknown projects |
| `DELETE /projects/:id/kill` | `projects.kill` + step-up | 404 without a hold |

All in the route-coverage list and the RBAC matrix. Console: **Usage → Enforcement** (pauses with "Resume
now", holds with "Release", concurrency in use, budgets with their enforcement, recent decisions linking to
jobs, the policy as validated JSON for admins, and the kill switch form); **Fleet** shows "codex paused until
…" on each covered worker. All writes go through the step-up dialog; strings render as text.

## 10. Data model (migration 0017, additive)

| Table | Purpose / invariants |
| --- | --- |
| `quota_policies` | append-only versions (`version = max + 1`, no UPDATE/DELETE/TRUNCATE) |
| `quota_pauses` | one per provider-limit report (unique source attempt); only an early resume may change a row, once; no DELETE |
| `quota_project_holds` | kill-switch holds (FK projects); history in the audit log |
| `quota_events` | append-only enforcement log; `dedupe_key` unique → each decision once |
| index `job_runs_error_code_idx` | the provider-limit scan |

## 11. Tests

- `packages/scheduler/test/quotas.test.ts` (21): limit narrowing, exceeded/incomplete semantics (lower bound
  ≥ limit is exceeded even with gaps; incomplete is never ok), project/runtime holds, account counted once,
  worker vs account pauses and expiry, pause clamping, placement exclusion, fair interleaving, load, weights,
  aging, **no starvation**, determinism.
- `apps/master/test/integration/quotas.test.ts` (12; real master + worker daemons + fake runtime): runaway
  stop by `maxTokens` on usage events (system actor, `budget_exceeded` reason, worker confirms, stopped
  early, one event + notification); project default `maxTurns`; dollar limit with unknown cost warn vs block;
  project budget over → held with reason, released by deleting the budget; project concurrency;
  account shared by two workers counts once; `provider_usage_limit` → worker pause visible in status →
  admin resume → re-dispatch (and a second pause); account pause covers a new member; kill switch (step-up,
  CANCELLING → CANCELLED, hold → `project_hold`, audited, release); writes need a fresh step-up and a valid
  policy; fair dispatch with a test-driven loop.
- Web: Usage → Enforcement (viewer read-only, hostile text, admin resume + kill switch with step-up), Fleet
  pause note.
- RBAC matrix and route coverage include the five routes.

## 12. Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| **T-OPS-2 runaway spend** | Per-job limits checked on every usage event and by a wall-time loop; stop is a durable CANCEL_JOB (survives master restarts/replay); incomplete figures never count as safe (`warn`/`block` policy); scope budgets hold new jobs; kill switch for a whole project; provider limits pause the runtime/account. | Enforcement granularity is one usage increment: a runtime that reports usage rarely (or only at the end) can overshoot by one increment; the wall-time limit bounds it. A worker that suppresses usage events is bounded by wall time only (T-WRK-2: usage is worker-reported). |
| T-WRK-3 compromised worker abuses pauses | A worker can pause only its own runtime (or its account) and only up to `maxPauseSec`; one pause per report; admins resume early. Usage attribution is already checked by p6-cost. | A worker can keep reporting limits (each failed attempt) — the effect is limited to its own account, which an admin can reconfigure. |
| T-CP-3 privilege misuse | Writes admin + fresh step-up + CSRF; kill switch project-scoped (`not_visible` → 404); every write audited; denials audited. | — |
| T-OPS-3 repudiation | Policy versions, pauses, events append-only (DB triggers); transitions carry the `system:quota` actor and reason; audit chain. | Table owner can disable triggers (production uses a non-owner role, as for audit). |
| Starvation / DoS of dispatch | Fair order with memory; admission is a few indexed queries per dispatch under the existing lock; status bounded (100 events). | Budget evaluation per dispatch (one aggregate per budget) — fine for tens of budgets; cache in p7-load. |
| Information leakage | Messages built from ids, codes and numbers; worker-supplied free text never enters `quota_events` or notifications; status filters project rows by visibility. | Worker ids and runtime names are visible to viewers (as in Fleet). |

## 13. Rollback and operations

Rollback: revert the code; 0017 only adds objects (forward-only runner: keep the schema or restore). Without
`QuotaService` the orchestrator behaves as before (no admissions/steps). Operational signals: `quota_events`
by kind/code (held, stopped, paused), active pauses, holds, `job_schedule_status` reasons
`budget_exceeded`/`project_concurrency`/`provider_paused`; log lines `job stopped by a run limit`, `project
kill switch`, `run limit check failed`.

## 14. UNVERIFIED

Real runtimes emitting `provider_usage_limit` (+ `resetAt`): the adapters map their provider errors to this code
since p6-quota-scheduling (detection tested on the texts the pinned binaries print; not yet seen on a live
account). Enforcement against real provider usage reports.
