# Design note: cost & efficiency — budgets with policies, dashboard, weekly report, suggestions (P8)

- **Status:** Implemented
- **Date:** 2026-10-16
- **Backlog:** `p8-cost-efficiency`
- **Builds on:** [p6-cost.md](p6-cost.md) (usage records, provenance, budgets, threshold outbox),
  [p4-quotas.md](p4-quotas.md) (admission, holds, `stop_running`), [p6-quota-scheduling.md](p6-quota-scheduling.md)
  (zoned wall-clock times), [p6-smart-routing.md](p6-smart-routing.md) (`job_stats`, routing rules),
  [p6-result-reuse.md](p6-result-reuse.md), [p6-warm-caches.md](p6-warm-caches.md),
  [p6-safe-auto-approve.md](p6-safe-auto-approve.md), [p6-capacity-advice.md](p6-capacity-advice.md),
  [p5-notifications.md](p5-notifications.md) + [p8-pwa.md](p8-pwa.md) (channels), [p5-ops-chat.md](p5-ops-chat.md).
- **Decisions applied:** ADR-0008 (cost provenance; unknown is never zero), ADR-0014 (subscription runs have no
  per-run dollars: tokens / turns / time; the runtime's "cost" for them is an API-equivalent estimate), ADR-0009
  (privileged writes: admin + step-up), ADR-0003/0004 (outbox, idempotency). No new ADR: no new trust boundary, no new
  dependency; every action reuses an existing route.
- **Threat model:** T-OPS-2 (runaway spend), T-OPS-3 (repudiation), T-CP-3 (privilege misuse), T-SEC-1 (no secrets in
  reports / notifications).

## 1. Problem

The cluster recorded usage and had generic budgets (UTC windows, 80/100 % alerts, always "hold new jobs"), but the
owner could not answer "what does this project cost this month, and what should I change?": no per-project policy
(warn vs pause vs only stop automations), no local-time windows, no trend, no per-kind/automation view, no weekly
summary, and the efficiency features (reuse, caches, safe auto-approve) had no visible effect. Many jobs run on a
Claude subscription, so dollars alone mislead.

## 2. Shape

```
packages/usage/src/periods.ts       pure: IANA-zone calendar periods (DST-aware), weekly slot (Mon 08:00 local)
packages/usage/src/budget.ts        billing filter, thresholds (percent), hard-limit policy, zoned windowBounds
packages/usage/src/aggregate.ts     apiEquivalent per group (subscription usage priced as if API-billed: estimate)
apps/master/src/usage/store.ts      p8 budget fields, threshold alerts per percent, overrides, pricedBuckets()
apps/master/src/quotas/service.ts   admission honours policy + overrides + automation origin; automationBlocked()
apps/master/src/automations/…       runs skipped ("budget exhausted until …") when a budget blocks them
apps/master/src/efficiency/         service.ts (dashboard, savings, CSV rows), suggestions.ts (pure rules),
                                    reports.ts (weekly report + scheduler), routes.ts, text.ts
apps/master/migrations/0068_cost_efficiency.sql
apps/web/src/screens/usage/         DashboardPanel, SuggestionsPanel, ReportsPanel (+ /usage/reports/:id), BudgetsPanel
```

## 3. Budgets (billing, time zone, thresholds, policy)

New columns on `usage_budgets` (defaults keep every pre-p8 budget unchanged):

| Column | Values | Default (existing rows) | Default (new via API) |
| --- | --- | --- | --- |
| `billing` | `all` · `api` (auth mode ≠ `local-login`, unknown auth counts as API — never assumed free) · `subscription` (`local-login`) | `all` | `all` |
| `time_zone` | IANA zone; windows are local calendar day / week (Mon) / month, DST-aware | `UTC` | `UTC` (console pre-fills the browser zone) |
| `thresholds` | 1–5 integer percents 1..100 | `{80,100}` | `{50,80,100}` |
| `on_exceeded` | `warn` · `pause_new` · `block_automations` | `pause_new` (= p4 behaviour) | `pause_new` |

A per-project "monthly USD (API) + optional daily USD + monthly subscription tokens/hours" setup is simply several
project-scoped budgets (`billing=api` cost_usd month/day, `billing=subscription` tokens or `wall_time_ms` month); the
console enters agent time in hours. `billing=subscription` with `cost_usd` is refused (`subscription_has_no_dollars`,
also a DB CHECK).

**Thresholds.** On each recorded usage event every covering budget (same billing class) is evaluated; for every
threshold the *known* consumption reached, one `usage_budget_alerts` row per (budget version, window, percent) is
inserted (`ON CONFLICT DO NOTHING` on a partial unique index); only the winning insert writes the outbox row, so each
threshold is announced exactly once per window. A pre-p8 alert of the same window (80 % `warning` / 100 % `exceeded`)
counts as already announced. Levels: < 80 % `notice`, ≥ 80 % `warning`, 100 % `exceeded`.

**Notifications.** The existing `budget.threshold` kind for 50/80 %; new kind **`budget.paused`** for the 100 %
crossing of a `pause_new` / `block_automations` budget (critical): "Budget exhausted: X — new jobs paused", with the
window end in the budget's zone ("until Sun, 1 Nov 2026, 00:00 (Europe/Istanbul)") and the override hint. Recipients
as before (project members for project budgets, else owners/admins); channels per the user's settings (in-app always,
e-mail / webhook / push opt-in per kind).

**Enforcement** (QuotaService admission, under the dispatch lock — the only dispatch path):

| Policy at 100 % | Effect |
| --- | --- |
| `warn` | nothing held; Enforcement shows "warning only (policy)" |
| `pause_new` | job stays QUEUED with `budget_exceeded`: "… is at 110 %: budget exhausted until <local window end>; new jobs wait (or the budget is raised, or an owner/admin overrides it)". Policy `stop_running` (global quota policy) still stops running jobs, only for `pause_new` budgets |
| `block_automations` | only jobs started by an automation (`automation_runs.job_id`, or a step of a workflow run an automation started) are held; automation runs that would start are **skipped** with the reason (recorded on the run, audited `automation.fire` denied `budget_exhausted`); jobs started by hand run |

`pause_new` also skips automation runs (they would only queue). The composer/chat placement preview treats the draft
as a hand-started job. Incomplete figures keep the p6/p4 semantics (`unknown` is never under; policy
`budgets.incomplete`), except that `warn` budgets never hold.

**Overrides** (`usage_budget_overrides`): an owner/admin (action `budgets.override`, project-scoped admin = global
owner/admin, fresh step-up, CSRF) lets work through an exhausted budget for the **current window** — every held job, or
one job (`jobId`, must be in the budget's project) — until `until` (default and maximum: the window end), with a
required reason. Bound to the budget version and window: editing the budget or a new window ends it. Revocable once
(`DELETE …/overrides/:id`); rows cannot be deleted (trigger). Audited `usage.budget.override` /
`usage.budget.override.revoke` (reason length only, not the text); granting re-runs a dispatch tick.

## 4. Dashboard (`GET /usage/dashboard`, viewer+, visible projects only)

Query: `from`, `to` (≤ 400 days, default 30 days), `grain` day|week|month, `timeZone` (validated), `dimension`
project|runtime|model|kind|automation|worker, optional `project`, `billing`.

- **totals / trends:** usage recorded in the period, priced at read time with the current price table (p6 rules).
  Trend buckets are local calendar periods (`date_trunc(grain, recorded_at AT TIME ZONE $tz)`; zone is a bound
  parameter, grain one of three literals), gaps filled. Each point: known API dollars + completeness, subscription
  records and their **API-equivalent estimate** (tokens × price table, else the runtime's own figure, else unpriced),
  tokens, turns, agent time.
- **breakdown:** usage regrouped per job → dimension (runtime / model / machine from the record; kind from the spec
  role or the routing heuristic; automation via `automation_runs` / workflow steps), plus outcomes of the jobs that
  **finished** in the period: succeeded / failed / cancelled, success rate, known dollars per successful job (whole job
  usage, "≥" when incomplete) and API-equivalent per success.
- **top costly** (period usage per job) and **slowest** (finished jobs by summed attempt time), linking to jobs.
- **success rates** per runtime × model from `job_stats` (all time; p50, cost per attempt).
- **savings (estimates, labelled):** result reuse hits (automation runs skipped + workflow steps reused in the period)
  × the reused job's own run time and known cost; warm-cache runs (attempts started where the shared cache was offered:
  project switch on, trusted, non-container — the worker may still decline, so "offered"); safe auto-approve:
  `approval.auto_safe` audit events × the measured median human decision time of `runtime.dangerous_tool` approvals in
  the period (or an assumed 120 s, flagged `measured: false`).
- Bounded: at most 5,000 jobs per query (`truncated` flag).

**CSV:** `GET /usage/export/breakdown.csv` (usage.read) and `/usage/export/jobs.csv` (usage.records, operator+) with
the dashboard query; cells via the audit exporter's `csvCell` (always quoted, formula prefixes neutralised). The
estimate column is named `api_equivalent_usd_estimate`.

## 5. Suggestions (`GET /usage/suggestions`, viewer+)

Pure, deterministic rules (`suggestions.ts`, no LLM) over `job_stats`, automations' last 30 days, budgets, missing
prices and (owners/admins only) machine capacity advice:

| Rule | Condition | One-click action (existing route, its own authz/step-up/audit) |
| --- | --- | --- |
| `cheaper_model` | same runtime × kind, ≥ 10 attempts each, another model ≤ 60 % of the cost per attempt, success within 5 points | global routing rule kind → catalog profile of that model (`PUT /routing/rules`, admin, step-up); no profile → link to Settings → Models |
| `failing_automation` | ≥ 40 % of ≥ 5 finished runs failed | pause (`POST /automations/:id/pause`, operator) |
| `enable_reuse` | cron/at job automation without reuse, ≥ 2 successful runs repeating an earlier successful prompt digest within 7 days | `PATCH /automations/:id {reuseWithinHours: 24}` (operator, step-up) |
| `lower_parallelism` | non-auto machine runs more parallel jobs than its measured recommendation | `POST /workers/config/bulk {maxParallelJobs}` (admin, step-up) |
| `budget_pace` | after ≥ 20 % of the window, on pace for ≥ 100 % | link to Budgets |
| `missing_price` | records without a price | link to Prices |
| `low_success` | runtime × model < 50 % over ≥ 10 attempts | link to Outcomes |

The console shows the evidence, asks for confirmation, uses the step-up dialog where the route needs one, hides
buttons below the action's role, maps only these action kinds to typed API calls and navigates only to
console-relative paths. Nothing is applied automatically.

## 6. Weekly report

- **Settings** (`user_report_settings`, `GET/PUT /reports/settings`, `reports.self`): IANA zone, weekly on/off, an
  optional chat thread that must be the user's own, non-archived thread (checked on save and again on every post). No
  row: UTC, **on for owners/admins**, off for operators/viewers (opt-in).
- **Schedule:** an orchestrator tick step (self-throttled to once a minute, ≤ 50 reports per pass): for each enabled,
  active user, the latest Monday 08:00 in their zone; if it has passed and no stored report overlaps that week by more
  than a day (a zone change mid-week never reports a week twice), the report of the Monday-to-Monday local week before
  it is generated. Missed slots (master down) catch up on the next tick; only the latest week (no backfill).
- **Content** (built for the user's visible projects at generation time, stored as JSON ≤ 512 KiB in
  `efficiency_reports`, unique per user and week): what ran (finished / succeeded / failed / cancelled, per project),
  what deployed (ops actions by kind / state), failures (job, project, runtime, error **code** only), spend vs previous
  week and every visible budget with policy and window end, top costly / slow jobs, savings, top 10 suggestions. A
  one-line summary from numbers only.
- **Delivery** in the inserting transaction: `report.weekly` notification (in-app; e-mail / push / webhook per the
  user's channel settings) linking to `/usage/reports/:id`; optional chat note (Markdown with every name escaped) in the
  chosen thread. Audited `report.weekly.generate` (system actor). `GET /reports`, `GET /reports/:id` (own only; 404
  otherwise), `GET /reports/weekly/preview?week=last|current` (computed, not stored).
- **LLM summary:** not implemented. If added later it must be an ordinary runtime job (existing quotas, approvals,
  budgets) and optional.

## 7. Data model (migration 0068, additive)

`usage_budgets` + `billing`, `time_zone`, `thresholds`, `on_exceeded`; `usage_budget_alerts` + `threshold_pct` (PK
replaced by two partial unique indexes: legacy per level, new per percent; level check gains `notice`);
`usage_budget_overrides` (revoke-once trigger, no delete/truncate); `user_report_settings`; `efficiency_reports`;
notification kind CHECKs gain `budget.paused`, `report.weekly` (rewritten with every kind on main at merge time).

## 8. API and authorization

| Route | Action |
| --- | --- |
| `GET /usage/dashboard`, `GET /usage/suggestions`, `GET /usage/export/breakdown.csv` | `usage.read` (viewer+, project-scoped data) |
| `GET /usage/export/jobs.csv` | `usage.records` (operator+) |
| `GET /budgets/:id/overrides` | `budgets.read` |
| `POST /budgets/:id/overrides`, `DELETE /budgets/:id/overrides/:overrideId` | **`budgets.override`** (new; admin) + step-up + CSRF |
| `GET/PUT /reports/settings`, `GET /reports`, `GET /reports/:id`, `GET /reports/weekly/preview` | **`reports.self`** (new; any role, own only) |

`POST/PUT /budgets` accept the optional p8 fields (omitted on update: unchanged — p6 clients keep working). All new
routes are in the route-coverage and RBAC matrix tests.

## 9. Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| T-OPS-2 runaway spend | Policy enforced at the single admission point under the dispatch lock; automation runs also gated before a job is created; `unknown` never under; thresholds once per window; `warn` explicitly chosen by an admin | A job created by an automation in the instant between the gate and the `automation_runs.job_id` update is still held at admission (the link exists before dispatch in practice; at worst it is treated as hand-started for one admission). Usage is worker-reported (p6 residual). |
| T-CP-3 privilege misuse | Budget writes / overrides: admin + fresh step-up + CSRF; override bounded to the current window and version, job must be in the budget's project, reason required; suggestions only *call existing routes* with their own checks; console never executes server-supplied URLs (whitelisted action kinds, console-relative paths) | — |
| T-OPS-3 repudiation | Overrides append-only except a single revocation (trigger); audit for create/revoke/denied, report generation, settings changes, automation skips | Table owner can disable triggers (as elsewhere). |
| Information leakage | Dashboard / suggestions / reports filtered by the caller's (report: recipient's) visible projects; global budgets and machine advice only for owners/admins; reports and settings strictly own (`reports.self`, 404 for others); chat thread must be own; report text from ids, codes, numbers and names — never prompts, runtime output or error messages (error *codes* are pattern-checked); Markdown-escaped in chat; React renders as text | Project/automation names and model ids are visible to project members (as today). |
| Injection | Group keys from whitelisted expressions; zone and all values bound; zone validated (`isValidTimeZone`, DB CHECK); CSV formula neutralisation | — |
| DoS | Ranges ≤ 400 days, ≤ 5,000 jobs per query, ≤ 400 trend points, report ≤ 512 KiB, ≤ 50 reports per tick, tick 1/min | Dashboard queries are heavier than p6 summaries; fine at current scale, cache in p7-load. |
| Secrets (T-SEC-1) | No new secret material; notifications go through `sanitizeDraft` (redaction) | — |

## 10. Tests

- `packages/usage/test/periods.test.ts` — zones, DST days (23/25 h), spring-forward gap, period series, weekly slot
  before/after Monday 08:00, thresholds normalisation/reached/levels; `aggregate.test.ts` API-equivalent.
- `apps/master/test/unit/cost-efficiency-suggestions.test.ts` — every rule's thresholds, no action without a profile,
  GitHub automations never suggested for reuse, auto machines skipped, deterministic order.
- `apps/master/test/integration/cost-efficiency.test.ts` — API budget ignores subscription usage; 50 / 80+100 announced
  once; `budget.paused` with zone text; hold reason "budget exhausted until Sun, 1 Nov 2026, 00:00 (Europe/Istanbul)";
  other project unaffected; override needs fresh step-up (403), per-job override admits only that job, viewer 403,
  revoke re-holds; `warn` never holds; `block_automations` holds automation jobs only and blocks automation runs;
  validation; dashboard scoping, API-equivalent separate from spend, CSV roles and headers, bad zone 400; weekly report
  not before Monday 08:00 local, once, notification + chat note, zone change never duplicates a week, others' reports
  404, viewers not opted in.
- Updated: notifications (`budget.paused`), usage (explicit p6 thresholds), rbac-matrix (two actions).
- Web `cost-efficiency.test.tsx` — dashboard defaults, estimate labels, hostile names as text, export roles;
  suggestion confirm + step-up + exact routing body, hidden for viewers, safe paths; budget exhausted text and
  override with step-up; report settings save; report page as text. `usage.test.tsx` adjusted (hours, defaults).

## 11. Rollback and operations

Additive migration; reverting the code leaves the columns with their defaults (old code ignores them; overrides and
reports become inert). Signals: audit `usage.budget.override*`, `report.weekly.generate`, `automation.fire` denied
`budget_exhausted`; quota events `dispatch_held` code `budget_exceeded`; log line `weekly report generation failed`.
No worker release (master + web only). No new env, no Traefik change.
