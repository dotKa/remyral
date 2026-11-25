# Design note: `p11-runtime-advice` — learn which runtime does well for which work, advise, and (opt-in) route

- **Task:** `p11-runtime-advice` (feedback P2, 2026-10-19: "Don't pick agents only by idle machines. Learn from past
  jobs which runtime is more successful for which job type, e.g. in a project Claude for frontend, Codex for test
  development — use it as a scheduler signal.").
- **Date:** 2026-10-19
- **Decision record:** [ADR-0044](../adr/0044-runtime-advice-from-outcomes.md)
- **Binding inputs:** p6-smart-routing (job kinds, routing rules, `job_stats`, placement scoring), p10-verify-health
  (verification states), p4-git-flow (branch verification, CI, merges), p8-orchestration (sub-job requests and their
  `paths`), p11-usage-limit-fallback (usage-limit episodes, paid policy), ADR-0011 (additive protocol), AGENTS.md.
- **Goal:** the platform knows, per project and work area, which runtime produced good results, tells people when they
  draft a job, and — only where a project admin opted in and only for jobs submitted with runtime "auto" — picks the
  runtime by it, explainably, never against an explicit choice or a hard constraint.

## 1. What existed (verified)

`packages/scheduler/src/placement.ts` scores eligible machines: `0.5 capacity + 0.3 reliability + 0.2 affinity −
0.3 retry penalty + 0.4 success + 0.1 speed`; success / speed come from `job_stats` per project × runtime × model ×
kind × machine (`OUTCOME_SCORING.minSamples = 5`, else the fleet). That history only ranks **machines** that already
passed the filters for the job's runtime; the runtime itself comes from the user, a routing rule (admin, per kind) or
the parent job. The kind is a leading-verb heuristic over the first prompt line. "Success" is the attempt outcome only.
Nothing knew *which part of a project* a job touches or whether a "succeeded" result was any good.

## 2. Classification (kind + area) — `packages/protocol/src/runtime-advice.ts`

Deterministic and explainable; no LLM in the scheduler path. `classifyJob(input)` returns the kind (unchanged:
`jobRoleOf` — explicit role, else the leading-verb heuristic), an **area** (`frontend | backend | tests | docs | infra`
or null) and every **signal** that fired with its weight:

| Source | Weight | What |
| --- | --- | --- |
| `explicit` | wins | `JobSpec.area` (additive, master-side, workers strip it) |
| `touched-paths` | 6, spread over the paths | `job_git.changes.files[].path` of the result (known when the job ends) |
| `paths-hint` | 4, spread | a sub-job's `paths` (coordinator request) |
| `file-types` | 1.5 each, ≤ 2 per area | file names with an extension mentioned in the prompt (`Header.tsx`) |
| `prompt` | 1 each, ≤ 3 per area | keywords, English and Turkish (stems with suffixes: "testleri", "veritabanına") |
| `template` | 1 each, ≤ 2 | the job template's title / the automation's name |

Paths map to an area by **globs**: the project's own rules (Projects → Policy → Runtime advice → Path rules) first,
then the built-in ones in order tests → docs → infra → frontend → backend (first match wins per path, so
`Button.test.tsx` is test work and `infra/README.md` documentation). The top area needs a score ≥ 2 **and** more than
1.5× the runner-up; otherwise the job is unclassified (no guess). Keywords match at a word start (`ui` never matches
`uint`). The prompt is read up to 4 000 characters.

**Stored** in `job_classifications` (one row per job: kind, area, sources, signals, scores, `stage`): at submission
(`submitted`, in the job store's create transaction behind a savepoint) and again when the job ends (`final`, with
touched paths, sub-job paths, template / automation). History is back-filled: migration 0093 inserts `job_outcomes`
rows for finished jobs (unclassified); the master classifies them after start in bounded batches (`backfill`).

## 3. Outcome quality — `judgeOutcome` (`packages/scheduler/src/runtime-advice.ts`)

`job_outcomes` holds one row per finished agent job (SUCCEEDED / FAILED; cancelled jobs, machine administration and
integration jobs say nothing about a runtime): the runtime and model **the last attempt ran with** (a usage-limit
fallback counts for the fallback), kind, area, succeeded, duration (sum of attempts), cost (usage records), the prompt
digest and the end time. The later signals are **joined at read time**, so they never go stale:

- p10 verification (`job_verifications`: failed = bad unless overridden by a human),
- git-flow branch verification and CI (`job_git.verification`, `ci_state` failure / timed out = bad),
- merge (`job_git.merged_at` or a `merged` request = merged; `discarded` / `denied` / `refused` = bad),
- **rerun**: the same prompt digest submitted again in the project within `rerunWindowDays` (default 3) after the job
  ended = corrected = bad,
- a human **👍 / 👎** (`job_ratings`, job page; 👎 is always bad, 👍 on a succeeded job is good whatever the automatic
  signals say; a failed job is never good).

Good = succeeded and nothing above says otherwise. The judgement and its reasons are shown on the job page.

## 4. Aggregation math

Per scope (project × area × runtime, optionally broken down by model) over the last 365 days:

```
weight w_i   = 0.5 ^ (age_days / halfLifeDays)                       (recency decay, default half-life 60 days)
prior        = fleet good rate of the same runtime × area (decayed), strength k = min(4, fleet weight); none: 50 %, k = 2
posterior    = Beta(α = Σ w·good + rate·k, β = Σ w·bad + (1 − rate)·k)
rate         = α / (α + β);  interval = rate ± 1.96·sd(Beta), clamped to [0, 1]
counted      = raw job count n ≥ minSamples (default 5)
trend        = raw good rate of the last 30 days vs the 30 days before
```

Median duration and mean reported cost of the cell travel with it. Everything is pure and unit-tested
(`packages/scheduler/test/runtime-advice.test.ts`).

## 5. Advice mode (default for every project)

`adviseRuntime` recommends the **counted** runtime with the best smoothed rate (ties: faster, cheaper, name), e.g.
"Recommended runtime for this project's frontend jobs: Claude Code — 91% good outcomes (n=23) vs Codex 74% (n=19);
median 12 min; est. cost $0.42". Confidence is *strong* when its interval lies above the runner-up's, else "(low
confidence)"; with no counted runtime it says how much history exists. Shown:

- **Composer → Where**: under the job kind, with "Use Claude Code" and, in an auto-mode project, "Let auto mode
  choose"; the area and the signals it was read from are listed.
- **Chat `draft_job` card**: the advice travels in the card payload and is told to the assistant (with "mention this to
  the user; do not change the runtime yourself"); the card keeps the drafted runtime.
- **Coordinator sub-job requests**: in advice mode the advice is added to the sub-job's placement notes (job page →
  Sub-jobs); the runtime is chosen exactly as before.

Advice never changes a job.

## 6. Auto mode (per project opt-in, admin)

Only when the project's mode is `auto` **and** the job is submitted with `spec.runtime: "auto"` (composer "Auto",
REST) — or a sub-job names no runtime and needs no capability. An explicit runtime is never touched. The master
resolves "auto" in `POST /jobs` **before** the job exists (workers never see it):

1. classify the draft; load the area's cells (project, fleet prior);
2. constraints → a candidate is excluded with a reason: not in `allowedRuntimes` (empty = all; sub-jobs: also the
   project's delegation runtimes); its resolved model bills per token and `allowPaid` is off; an open account /
   credential usage-limit episode (p11-usage-limit-fallback); a quota hold; no machine could run it (placement
   preview);
3. `chooseAutoRuntime`: the best counted candidate; with probability `explorationPct` (default 10 %, at most 30 %, one
   draw per decision) the least-sampled uncounted candidate instead — never for a production deploy-on-success job and
   never while nothing is counted; nothing counted → the first available runtime of the kind's routing rule, else the
   first available;
4. nothing available → `400 runtime_auto_unavailable` with the reasons, no job; mode not `auto` → `400
   runtime_auto_not_enabled`.

The decision (runtime, how — best / explore / fallback —, reasons, considered candidates) is written to
`job_runtime_decisions` in the job's creation transaction and shown on the job page: "Auto mode chose Claude Code
(best expected outcome): best expected outcome: Claude Code 91% good (n=23) vs Codex 74% (n=19); Pi skipped: at its
usage limit until …". Machine placement afterwards is unchanged (the p6 scoring ranks machines for the chosen runtime).

## 7. API, console

| Endpoint | Authz | |
| --- | --- | --- |
| `POST /routing/advice` | `jobs.create` on the body's project (like the placement preview) | classification + advice for a draft; no side effects |
| `GET /usage/runtime-outcomes?project=` | `usage.read`, visible projects only (hidden = 404) | runtime × area cells (rate, interval, n, raw rate, median, cost, trend, models) + advice per area |
| `GET /projects/:id/runtime-advice` | `policy.read` | settings |
| `PUT /projects/:id/runtime-advice` | `policy.write` + step-up, audited `project.runtime_advice.update` (before / after) | mode, explorationPct, minSamples, allowedRuntimes, allowPaid, halfLifeDays, rerunWindowDays, areaRules |
| `PUT /jobs/:id/rating` | `jobs.merge` (operator+: the acceptance judgement), audited `job.rating.set`; finished jobs only (409) | `{rating: 1 \| -1 \| null}` |
| `GET /jobs/:id/runtime-outcome` | `jobs.read` | classification + signals, auto decision, rating, judgement |
| `POST /jobs` | unchanged | `spec.runtime: "auto"` accepted (§6) |

Console: Projects → Policy → **Runtime advice**; Composer → Where advice note and the "Auto (by outcome history)"
runtime; chat card advice line; job page **Runtime and outcome** card with 👍 / 👎; Usage → Outcomes **Runtime × work
area** matrix (above the p6 rollup table).

## 8. Security review

- **Authorization:** advice reveals a project's outcome statistics only to those who may create jobs there; the matrix
  follows `usage.read` with project visibility; settings are project policy (admin + step-up, audited); ratings need
  operator+ and are audited. All actions already exist in the RBAC catalog (matrix test unchanged).
- **Untrusted input:** the prompt, paths and template names only feed a fixed keyword / glob table; they can steer a
  job's *area* and therefore at most which admin-allowed runtime auto mode picks — never a runtime outside the allowed
  list, never past the paid policy, usage limits, quota holds or placement filters, never a model, credential or
  machine. Repository contents never reach the classifier, only the paths the result changed (already shown on the job
  page). Glob rules are admin input, bounded (≤ 10 areas × 30 globs, ≤ 200 characters) and compiled without
  backtracking-prone constructs (`*` → `[^/]*`, `**` → `.*`), anchored.
- **No override:** advice is text; auto mode acts only on the explicit value "auto" in a project an admin switched to
  auto; exploration is bounded (≤ 30 %, default 10 %) and excluded for production deploys.
- **Secrets:** nothing secret is read or stored (counts, durations, dollars, path names already visible on the job).
- **Availability / integrity:** classification and outcome writes run behind savepoints in the job store and can never
  fail a transition (reported like the p6 rollup); advice failures show nothing and never block a draft or a sub-job;
  auto failures refuse the submission with reasons (no silent fallback to some runtime). Reads are bounded (365 days,
  20 000 rows, indexed by project / area / end time).

## 9. Rollback, operations

- **Rollback:** set the project's mode to `off` (or `advice`) — auto stops at once; jobs keep their concrete runtime.
  Migration 0093 is additive (five new tables); an older master ignores them and would refuse `runtime: "auto"` as an
  invalid runtime (no job is created).
- **Deploy:** master + console. **No worker release** (`JobSpec.area` is master-side; "auto" never reaches a worker).
- **Logs / metrics:** `runtime advice backfill failed` (component `runtime-advice`), the job store's rollup error hook
  for classification / outcome writes, `runtime advice for a sub-job failed; using the routing rule`; Usage → Outcomes
  is the operational view; audit `project.runtime_advice.update`, `job.rating.set`.

## 10. Tests

- `packages/protocol/test/runtime-advice.test.ts` — globs, first-match order, project rules, TR / EN prompts per area,
  touched paths vs prompt, path hints, file names, template name, explicit area, ties and weak evidence unclassified,
  word boundaries, determinism, settings bounds, `JobSpec.area`.
- `packages/scheduler/test/runtime-advice.test.ts` — good-outcome judgement, decay, Beta smoothing and interval, fleet
  prior, trend, min samples, advice text and confidence, auto choice honouring exclusions, exploration share bounded
  (seeded 2 000 draws ≈ 10 %), never when not allowed, routing-order fallback.
- `apps/master/test/integration/runtime-advice.test.ts` (real Postgres) — classification at submission and final with
  touched paths, outcome rows (cancelled: none), advice API and authz, rating (👎 flips, 409 unfinished, viewer 403),
  rerun detection, settings API (step-up, validation, audit), `runtime: "auto"` refused when off / when nothing can run
  (no job), explicit runtime never overridden, auto choice with allowed runtimes, usage-limit exclusion, no exploration
  for production, decision recorded and shown, matrix and visibility, back-fill.
- `apps/web/test/runtime-advice.test.tsx` — advice note (use / auto buttons), chat card advice, job page card and
  rating, settings section with step-up, matrix.
