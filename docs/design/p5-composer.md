# Design note: job composer — project, repo, branch, agent, model, constraints, DAG, budget, schedule (P5)

- **Status:** Implemented
- **Date:** 2026-10-13
- **Backlog:** `p5-composer`
- **Decisions applied:** ADR-0009 (step-up for privileged writes), ADR-0010 (untrusted source → container),
  ADR-0007 (host profiles need the project opt-in), ADR-0011 (additive protocol fields in 1.0), ADR-0012 (pins),
  ADR-0014 (run budgets).
- **Builds on:** [p4-orchestration.md](p4-orchestration.md) (POST /jobs, JobSpec, placement reasons),
  [p4-dag.md](p4-dag.md), [p4-quotas.md](p4-quotas.md), [p6-cost.md](p6-cost.md),
  [p3-runtime-policy.md](p3-runtime-policy.md), [p4-git-flow.md](p4-git-flow.md), [p5-rbac.md](p5-rbac.md),
  [p1-web-skeleton.md](p1-web-skeleton.md).
- **Threat model:** T-CP-1/T-CP-3 (privilege misuse), T-OPS-2 (runaway spend), T-OPS-3 (repudiation), T-SEC-1.

## 1. Shape

```
packages/protocol      JobSpec.requirements.{tools?, workers?}                     (additive, 1.0)
packages/scheduler     placement: tools / worker affinity filters (tool_missing, worker_not_selected),
                       PlacementWorker.tools?, policyBlocks? (runtime_not_allowed_by_policy, model_profile_not_allowed)
apps/master/src/composer   preview.ts (side-effect-free placement preview), routes.ts
apps/master/src/schedules  cron.ts (5-field UTC cron), service.ts (ScheduleService + tick step), routes.ts
apps/master/src/quotas     QuotaService.preview() (admission without side effects; shared #workerAdjust)
apps/master/src/orchestration  dispatch honours tools/workers; Orchestrator.candidates() public
apps/master/migrations     0018_schedules_and_fleet.sql (job_schedules; workers.sandbox_readiness for p5-fleet-ui)
apps/web/src/api/composer.ts
apps/web/src/screens/composer   ComposerPage (/jobs/new), SchedulesPage (/jobs/schedules), draft.ts, fields.tsx,
                                placement.tsx
```

## 2. The composer (web)

A guided form, mobile first (one column, horizontally scrolling step chips, 44 px targets; on ≥ 1024 px a step
list on the left and a sticky "Where would this run?" panel on the right). Two modes:

- **Single job** — Project → Repository (URL + base branch prefilled from `GET /projects/:id/git`; work branch;
  source trust) → Runtime & model → Sandbox & constraints → Limits & approval → Prompt → Schedule & submit.
- **Workflow run** — Project → Workflow & inputs (saved definition, graph preview with the run view's
  `WorkflowGraph`, inputs, optional repository override) → Schedule & submit.

| Field | Source of the options / defaults |
| --- | --- |
| Project | `GET /projects`, only projects where the caller is operator+ |
| Repository / base branch | the project's git configuration (job mode; workflow mode uses the definition default) |
| Runtime | all five; availability per runtime from the preview: *ready on N*, *busy/offline* (waits) or *unavailable* with the first permanent reason code + message (capabilities, pin, policy, constraints). Infeasible runtimes are disabled |
| Model profile | preview `modelProfiles`: union of the workers' effective runtime-policy profiles for the runtime, restricted by `projectProfiles`; default marked |
| Sandbox | container / runtime-sandbox / host-restricted with "ready on N"; host profiles disabled for untrusted source or without the project's host opt-in |
| Constraints | OS, arch (any = none checked), required tools (workers' reported tools listed), worker affinity |
| Limits | duration, cost, tokens, turns — prefilled once per project from the quota policy's project/global `jobLimits` (a job can only be stricter); applicable budgets with % used |
| Approval policy, priority | protocol enums; `ask-sensitive` default |
| Prompt | multi-line, byte counter (256 KiB), **context bundle preview** (`GET /context/bundle`) with hash, items, withheld markers |
| Schedule | Run now / At a time (local datetime → ISO) / Repeat (cron, UTC, next 3 runs from `GET /schedules/cron-preview`) |

**Validation** (`draft.ts`) mirrors the protocol `JobSpec`: https/ssh URL (scp-style explained), refs ≤ 255
(plus git ref syntax), duration 1 min … 7 days, non-negative cost, positive integer tokens/turns, tool names,
≤ 16 tools/workers, prompt ≤ 256 KiB, untrusted ⇒ container, priority −100…100. A contract test parses the built
spec with the real `@remyral/protocol` schema (web devDependency, tests only). The master validates again.
Errors appear per step after "Next"; submitting jumps to the first step with errors.

**Submit:** now → `POST /jobs` → `/jobs/:id`, or `POST /workflows/:id/runs` → `/jobs/workflows/:runId`; later →
`POST /schedules` through the step-up dialog → `/jobs/schedules`.

## 3. Master read endpoints

| Route | Action | Notes |
| --- | --- | --- |
| `POST /jobs/placement-preview` | `jobs.create` on the body project (operator+) | Draft without prompt/repository. Runs `place()` over `Orchestrator.candidates()` (the facts dispatch uses) with the quota admission's worker exclusions (`QuotaService.preview`, no events, no provider scan) and policy blocks from each worker's effective runtime policy. Returns verdict (`placed/waiting/infeasible/held`), ranked candidates, per-worker reasons, per-runtime availability, model profiles, sandbox readiness, limit defaults, issues (untrusted ⇒ container; host opt-in), worker list. **No writes** (integration test counts jobs, schedule status, leases). POST because the draft is structured; CSRF applies |
| `GET /workflows/:id` | `workflows.read` on the definition's project | graph (node id, role, runtime, gate, dynamic), edges, inputs, defaults — **no node prompts** |

Dispatch also honours the new constraints (`tool_missing`, `worker_not_selected`, both permanent). Policy blocks
are preview-only: dispatch keeps relying on the worker's typed refusal (it is authoritative on its applied
policy), which the preview predicts.

## 4. Schedules (migration 0018)

No scheduler backend existed, so a minimal one was added: `job_schedules` (job spec + priority, or workflow
definition + inputs + repository; `run_at` xor `cron`; state `active|done|cancelled|failed`; last run status,
job/run id, error, count). The sweeper is an orchestrator **tick step** (every loop pass; tests drive it).

- **At most once per occurrence:** due rows are selected `FOR UPDATE SKIP LOCKED`, advanced (next run or `done`)
  and marked `firing` in one transaction, then submitted. A crash after the commit skips that occurrence; it is
  never submitted twice (two concurrent sweepers → one job, tested). Missed occurrences are not backfilled.
- **Submitted as the creator, re-authorized at every fire:** account enabled and `jobs.create` /
  `workflows.run` in the project as of now; otherwise the schedule becomes `failed`, nothing is submitted, audit
  `schedule.fire` `denied` (tested by removing the membership).
- **Cron:** 5 fields, UTC, `* , - /`, dom/dow OR semantics, no names; at most every 5 minutes; one-shot ≤ 1 year
  ahead; ≤ 50 active per project.
- **REST:** `GET /schedules[?project]` and `GET /schedules/cron-preview` (`schedules.read`, viewer+, lists
  filtered to visible projects), `POST /schedules` (`schedules.write`, operator+, **step-up**, spec validated
  against JobSpec with paths/codes only), `DELETE /schedules/:id` (`schedules.write`; cancels, keeps the row).
  Audit: `schedule.create`, `schedule.cancel`, `schedule.fire` (success / failure / denied).

## 5. Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Preview as an oracle / side channel | Same authorization as submitting (operator+ member); reveals only worker names, states, tools and reason messages that `GET /workers` (viewer+) already shows; no writes | Load: ~6 placements per call; the UI debounces (350 ms) |
| Schedules as privilege persistence | Step-up to create; creator re-authorized at every fire; disabling the account or removing the membership stops them; all fires audited with the creator | A schedule keeps running while its creator keeps access (by design; visible on /jobs/schedules) |
| Duplicate submissions | Claim-and-advance before submit; SKIP LOCKED for replicas | An occurrence can be lost on a crash (documented, never doubled) |
| Prompt leakage | Prompts never in preview requests, workflow definition reads, audit metadata or error messages (paths/codes only); stored in `job_schedules.job_spec` like `jobs.spec` | Same at-rest treatment as jobs |
| XSS | All API text rendered as React text; bundle content in `<pre>` | — |
| Untrusted repo / host execution | UI and preview enforce untrusted ⇒ container and the host opt-in; the worker still enforces both | — |

## 6. Tests

- `packages/scheduler` placement (+3): affinity, tools, infeasible with both reasons. `packages/protocol` (+1).
- `apps/master/test/unit/schedule-cron.test.ts` (24): next-run table (steps, ranges, lists, DST-free UTC, leap
  day, dom/dow OR, never-matching), intervals, rejections.
- `apps/master/test/integration/composer.test.ts` (7, real master + two real worker daemons, fake runtime):
  preview over the real fleet without side effects; tool/affinity reasons; real dispatch honours affinity and
  tools; definition read without prompts; cron validation and step-up; cron fire at most once under two racing
  sweepers, re-arm, cancel, audit; one-shot workflow schedule; creator losing access ⇒ `failed`, no job.
- RBAC matrix + route coverage include the four new routes and two new actions (`schedules.read`,
  `schedules.write`).
- `apps/web/test/composer.test.tsx` (20): draft validation vs protocol schema, limit defaults, no prompt in
  previews; full job walk-through (operator-only projects, git prefill, runtime reasons, model profiles,
  affinity reasons, limits prefill, prompt required, submitted spec parses with the protocol); workflow cron
  schedule through step-up with graph preview and required inputs; schedules list + cancel.
- `apps/web/e2e/composer.spec.ts` (3, real master, not in `pnpm verify`): mobile + desktop compose → preview
  ("waits: worker offline") → limits prefilled → bundle preview → submit → job page; cron schedule with step-up.
  Screenshots: `docs/design/screens/p5-console/composer-*.png`. Parallel worktrees can isolate runs with
  `E2E_DB_NAME`, `E2E_REDIS_DB`, `E2E_*_PORT` and `E2E_SERVER_TIMEOUT_MS`.

## 7. Rollback and operations

Migration 0018 only adds a table and a nullable column (forward-only runner): roll back the code, or keep the
schema. Cancel all schedules with `UPDATE job_schedules SET state='cancelled', next_run_at=NULL WHERE state='active'`
before a rollback if they must not fire. Signals: `schedule.fire` audit outcomes, `job_schedules` rows with
`last_status='firing'` older than a minute (crash mid-fire), `failed` schedules.

## 8. UNVERIFIED

Time zones other than UTC for cron (not supported); scheduling under multiple master replicas (SKIP LOCKED is
replica-safe, untested with replicas); the composer on Safari/iOS (Chromium only).
