# Design note: `p6-smart-routing` — routing rules, outcome statistics, explainable placement

- **Task:** `p6-smart-routing` (plan: [p6-efficiency](p6-efficiency.md)).
- **Date:** 2026-10-16
- **Binding inputs:** p4-orchestration §4 (placement is pure, the master loads the facts), p5-credentials-models §5a
  (how a job's model is decided), p6-automations §2a/§2b (the shared project defaults module
  `apps/master/src/composer/defaults.ts`), ADR-0011 (additive protocol), ADR-0023 (four runtimes), AGENTS.md.
- **Goal:** the model and runtime of a job follow *what kind of work it is* when the job names none, and the
  scheduler prefers machines that did this kind of work well before — explainably, never against an explicit
  choice or a hard constraint, and identical to today's behaviour while no rule and no statistics exist.
- **Extended by** [p11-runtime-advice](p11-runtime-advice.md) ([ADR-0044](../adr/0044-runtime-advice-from-outcomes.md)):
  jobs also get a work area (frontend / backend / tests / docs / infra), outcomes are judged beyond "succeeded"
  (verification, CI, merge, reruns, 👍 / 👎) and aggregated per project × area × runtime; that record is shown as
  runtime advice and, only for runtime "auto" in projects that opted in, chooses the runtime. The machine scoring
  below is unchanged.

## 1. Shape

```
 composer / chat draft / automation / workflow step / REST
        │ spec (role? runtime? model?)
        ▼
 ProjectDefaults.apply ── runtime missing? → routing rule of the kind → first runtime a machine can run (§2)
        ▼
 JobStore.create ── model missing? → routing rule profile (if it fits the runtime) → project / global default (§2)
        ▼
 Orchestrator.dispatch ── candidates + job_stats outcomes per machine → place() → ranked + "chosen because …" (§4)
        ▼                                                              │
 job_schedule_status.explanation ──► GET /jobs/:id (Details: Kind, Placement)
        ▼
 attempt ends (JobStore.commit, same transaction, savepoint) ──► job_stats rollup (§3) ──► GET /usage/job-stats
```

## 2. Job kind and routing rules

**Kind.** `JobSpec.role` (optional, additive, `plan | execute | verify | summarise | research | chore`). Absent →
`inferJobRole(prompt)` (`packages/protocol/src/routing.ts`), a deliberately conservative heuristic: only the
*leading verb of the first non-empty line* counts (after markdown markers and a leading "please"/"lütfen"), at most
400 characters are read, and anything else is **unclassified** (no guess). Examples: "Review PR #12" → verify,
"Summarise …" → summarise, "Plan/Design/Propose …" → plan, "Research/Investigate/Compare …" → research,
"Bump/Upgrade/Format/Lint/Rename …" → chore, "Fix/Implement/Add/Refactor …" → execute; "The login page is broken"
→ unclassified. A few Turkish verbs are recognised (özetle, planla, doğrula, kontrol et, araştır, düzelt, ekle,
uygula). Machine-administration jobs have no kind. Workflow steps carry an explicit role from the step role
(planner → plan, executor → execute, verifier/reviewer → verify, integrator → chore); tasks a planner writes are
`execute` (their own role), never `plan`.

The kind is not stored separately: it is computed from the spec wherever needed (`jobRoleOf`), deterministic
because the spec is immutable. Workers ignore `role` (older builds strip it when parsing; the lease signature does
not cover the spec) — **no worker release is needed**.

**Rules.** `routing_rules (project, role, model_profile, runtimes)`; project `''` = global (Settings → Models →
Routing), otherwise an override for one project (Projects → Policy → Routing). A project rule replaces the global
rule of that kind *as a whole* (predictable: what you see on the project is what applies). A rule names a model
catalog profile, a runtime order, or both; a rule naming neither is deleted ("clear").

**Resolution (explicit always wins):**

| Field | Order |
| --- | --- |
| model (job store, every submission path) | job's `model` → rule profile *if enabled and offered for the job's runtime* → project default → global default → the worker's own default |
| runtime (drafting paths that may omit it: `ProjectDefaults.apply` — automations REST/form/chat; workflow steps without a runtime) | job's / step's `runtime` → first runtime of the rule's order some machine can take now (placement preview), else one some machine could run later → otherwise left out (automations then refuse it as before) / the definition's default runtime (workflows) |
| runtime (composer) | the user's choice → the preview's `routing.runtime` as the initial choice of a blank draft → the old "first runtime a machine can run now" |

A rule whose profile does not fit the job's runtime is skipped silently (the defaults apply); the audit of
`job.create` records `modelSource` (`project-routing`, `global-routing`, `project-default`, …) and `role` /
`roleSource`. Chat `draft_job` keeps its required `runtime` (the assistant's tool schema is worker-side; changing it
would need a worker release) — its jobs get the routed model through the job store like every other path.

## 3. `job_stats` outcome rollup (migration 0051)

One row per project × runtime × model (`''` = worker default) × kind (`''` = unclassified) × machine with
attempts, succeeded, failed, an 11-bucket duration histogram (upper bounds 30 s, 1, 2, 5, 10, 15, 30 min, 1, 2,
4 h, +∞), the duration sum, reported cost (and how many attempts reported one), input/output tokens, first/last
time.

- **Maintained incrementally** in `JobStore.commit`, in the transaction of the transition that ends the attempt:
  outcome `succeeded` and `failed` count, `retry` counts as failed, `cancelled` and `declined` do not count. The
  upsert adds the attempt's histogram vector element-wise. Cost and tokens are the attempt's `usage_records` at that
  moment (usage events arrive before the result; a straggler after the end is not added — documented limit).
- **Never blocks a transition:** the update runs behind a savepoint; a failure is rolled back to it, logged
  (`job_stats rollup update failed`, component `routing`) and the transition commits.
- **Quantiles** p50 / p90 are estimated by linear interpolation inside the histogram bucket (the open last bucket
  reports its lower bound). Exact enough to rank machines; the mean is exact.
- **API:** `GET /usage/job-stats?groupBy=runtime,model,kind,project,worker&project=&runtime=&kind=&workerId=`
  (`usage.read`, viewer+; rows of projects the caller cannot see are never returned; a hidden project filter is a
  404). Console: Usage → Outcomes.

## 4. Scheduler scoring and explanation (`packages/scheduler` placement)

The master attaches to every candidate worker its outcomes for exactly the job's runtime × model × kind
(`outcomesFor`): this project's numbers when they have at least `minSamples` attempts, else the sum across projects
(scope `fleet`). Placement stays pure and deterministic.

```
success = (succeeded + priorRate·priorWeight) / (samples + priorWeight) − priorRate     (samples ≥ minSamples, else 0)
speed   = clamp((reference − p50) / reference, −1, 1)    reference = median p50 of ≥ 2 eligible machines with stats, else 0
score   = previous score + 0.4·success + 0.1·speed        OUTCOME_SCORING: minSamples 5, priorRate 0.8, priorWeight 4
```

- **Safe defaults:** with no (or too few) statistics both terms are exactly 0 → the score and the ranking equal
  today's (unit test). A machine performing exactly like the prior scores like an unknown one.
- **Never overrides:** outcomes only rank workers that already passed every eligibility filter (hard constraints,
  worker pins, secret binding, sandbox, quota blocks) and never change the job's runtime or model. Capacity (0.5)
  still dominates a modest record difference.
- **Explanation:** `place()` returns `explanation` for the first-ranked worker: "chosen because it scored highest of
  3 eligible machines (0.93 vs 0.71); 2 of 2 slots free; 9 of 10 earlier verify attempts with codex · cheap
  succeeded here in this project, median 4m 10s; faster than the other machines with history; it ran this project
  recently (warm mirror)" — or "no outcome history yet for …" / "its outcome history is too small to count (2 of
  5 …)". Stored in `job_schedule_status.explanation` (placed only), returned by `GET /jobs/:id`
  (`orchestration.schedule.explanation`, `orchestration.kind`), shown on the job page (Details → Kind, Placement)
  and, for a draft, in the composer's "Where would this run?" panel (`placement.explanation`).

## 5. API changes (all additive)

| Endpoint | Change |
| --- | --- |
| `GET /routing/rules[?project=]` | new — global rules plus the project's overrides (`models.read`, viewer+) |
| `PUT /routing/rules` | new — `{project\|null, role, modelProfile\|null, runtimes[]}`; set or clear (`models.write`, admin, step-up, CSRF); validation: known enabled profile, offered for at least one runtime of the order, distinct current runtimes (a removed runtime → `runtime_removed`), project exists; audit `routing.rule.set` / `routing.rule.clear` |
| `GET /usage/job-stats` | new (§3) |
| `POST /jobs/placement-preview` | body: `role?`, `promptHead?` (≤ 400 chars); response: `routing {role, roleSource, rule, runtime}`, `placement.explanation`, `model.defaultSource` |
| `GET /jobs/:id` | `orchestration.schedule.explanation`, `orchestration.kind` |
| `DELETE /models/:id` | a profile named by a routing rule is "in use" (409), like a default |

## 6. Console

- **Settings → Models → Routing**: one row per kind (rule or "No rule: the model defaults apply"), Clear, and a form
  (kind, preferred profile, runtime order by ticking in order).
- **Projects → Policy → Routing**: the same for the project; rows show the inherited all-projects rule or the
  override.
- **Composer → Where**: "Job kind" (From the prompt (detected: …) / explicit), the rule in force, "Use <runtime>"
  when the rule prefers another runtime; the model select labels a routed default "Routing: …"; the placement panel
  shows "Chosen because …". Only the first 60 characters of the prompt's first line travel with the preview (the
  heuristic needs only the leading verb); with an explicit kind none does.
- **Usage → Outcomes**: grouped table (runtime, model, kind, project, machine) with attempts, success, p50, p90,
  cost per attempt.

## 7. Security review

- **Authorization:** rules are model configuration → same actions as model defaults (`models.read` viewer+,
  `models.write` admin + step-up + CSRF); statistics → `usage.read`, filtered to visible projects (non-members see
  neither rows nor a hidden project's existence). Both covered by the generated RBAC matrix and route coverage.
- **Untrusted input:** the prompt only selects among admin-defined rules; it can never name a model, a runtime or a
  credential that an admin did not configure, never bypass placement filters, and explicit job fields still pass
  every existing check (job store, worker gate). A repository's content never reaches the heuristic (only the
  submitted prompt). Kind spoofing (a prompt starting with "Review") can at most pick the admin's verify rule.
- **Secrets:** no secret is read or stored; rules reference catalog ids; statistics hold counts, durations, dollars,
  tokens. The preview receives at most the start of the first prompt line (no repository, no inputs).
- **Availability:** rollup failures cannot fail a transition (savepoint); statistics read failures place without
  them (logged). The rollup is one upsert per ended attempt; placement reads one indexed key
  (`job_stats_lookup (runtime, model, kind, worker_id)`).
- **Integrity / audit:** rule changes are audited with before-state implied by the history; `job.create` audit carries
  the model source and kind.

## 8. Rollback, operations

- **Rollback:** delete the rules (Clear) → model/runtime choice is today's; statistics affect ranking only, and
  `OUTCOME_SCORING` weights can be set to 0 in a code change. Migration 0051 is forward-only and additive (two new
  tables, one nullable column); older masters ignore them.
- **Metrics / logs:** `job_stats rollup update failed` and `job outcome statistics unavailable; placing without
  them` warnings; Usage → Outcomes is the operational view; `job.create` audit `modelSource` shows how often
  routing decided.
- **Deploy:** master + console; migration 0051 runs on start. No worker release, no env, no Traefik change.

## 9. Tests

- `packages/protocol/test/routing.test.ts` — heuristic (positive, negative, first line only, 400 chars), explicit
  role, workflow mapping, `JobSpec.role`, rule resolution, runtime order.
- `packages/scheduler/test/outcome-scoring.test.ts` — no stats = old score exactly, min sample size, prior-neutral
  machine, success / speed ranking, hard constraints and pins never overridden, capacity dominance, determinism
  (input order), explanation texts.
- `apps/master/test/unit/smart-routing.test.ts` — defaults runtime routing, model resolution order, histogram and
  quantiles, stats key.
- `apps/master/test/integration/smart-routing.test.ts` (real Postgres) — rules API (authz, validation, audit, clear,
  in-use profile), routed model at submission (project override, global, explicit role, explicit model, unfit
  profile), rollup through real transitions (succeeded / failed / cancelled, duration, cost, tokens), rollup failure
  does not block the transition, project vs fleet scope, grouping and visibility, `/usage/job-stats`, preview
  routing facts; `orchestration.test.ts` — explanation, kind and rollup end to end with a real worker;
  `workflows.test.ts` — every step's role.
- `apps/web/test/smart-routing.test.tsx` — parsing, composer kind / routing hint / "Use runtime" / explanation,
  Settings routing editor, project overrides, Usage → Outcomes.
