# Design note: cost attribution with provenance and gap flags (P6)

- **Status:** Implemented
- **Date:** 2026-10-13
- **Backlog:** p6-cost (acceptance A-UX-4: tool/model usage and costs show source and gaps). Provides the
  budget inputs and threshold events for p4-quotas (enforcement) and p6-alerts (alarms).
- **Decisions applied:** ADR-0008 (every cost carries provenance `reported-by-runtime` |
  `estimated-from-tokens` | `unknown`), ADR-0014 (subscription runs have no per-run dollar cost: budget by
  tokens/turns/time), ADR-0009 (step-up for privileged writes), ADR-0003/0004 (transactional outbox,
  at-least-once delivery → idempotent ingestion), docs/compat/README.md §2/§4.4 (Codex reports tokens only;
  the others report their own estimates).
- **Threat model:** T-OPS-2 (runaway agent spends budget), T-OPS-3 (tampering with history), T-WRK-3
  (compromised worker floods/forges messages), T-SEC-1 (no secrets in stored data).

## 1. Scope

| Piece | Where | Responsibility |
| --- | --- | --- |
| Pure math | `packages/usage` (`@remyral/usage`) | Cost classes and provenance, price selection, token-based estimates, aggregation with coverage flags, budget windows and evaluation. No DB, no I/O. |
| Store | `apps/master/src/usage/store.ts` | `UsageStore`: idempotent ingestion (`recordUsage`), summaries, records, price table versions, budgets, threshold alerts + outbox. |
| REST | `apps/master/src/usage/routes.ts` | `/usage/*`, `/budgets*`. |
| Outbox contract | `apps/master/src/usage/outbox.ts` | `usage.budget.threshold` payload schema. |
| Migration | `apps/master/migrations/0009_usage.sql` | `usage_records`, `usage_price_tables`, `usage_prices`, `usage_budgets`, `usage_budget_alerts` + invariant triggers. |
| Protocol | `packages/protocol` `AgentEvent{kind:'usage'}` | Optional attribution fields (backward compatible, §2). |
| Console | `apps/web/src/screens/usage/` | Usage section (`/usage`): overview, price-table editor, budgets editor. |

**Why a new package** rather than `packages/scheduler`: the scheduler package is the job state machine;
cost math has a different reason to change (price/provenance rules), is needed by master, by p4-quotas and
potentially the worker, and must stay free of DB and protocol coupling. It has no runtime dependencies.

## 2. Usage events (protocol)

`AgentEvent{kind:'usage'}` is an **increment** since the previous usage event of the same attempt (never a
running total), so events can be summed. Fields added as optional in protocol 1.0 (a v1.0 worker that sends
only `inputTokens/outputTokens/costUsd/provenance` stays valid; unknown fields were already stripped):
`cacheReadTokens`, `cacheWriteTokens`, `turns`, `durationMs`, `provider` (lower-case id), `model`,
`authMode` (`secret-ref` | `local-login`, never a credential). An absent value means **not reported** and is
stored as `NULL`, shown as a gap, never as zero.

## 3. Cost classes (the rule)

Every record gets exactly one class, decided by the pure `classify()` (first match wins):

| Class | When | Dollar value | Provenance shown |
| --- | --- | --- | --- |
| `subscription` | `authMode = local-login` (ADR-0014) | none — "no per-run cost" | — |
| `reported` | event provenance `reported-by-runtime` **and** a `costUsd` value | the runtime's value | `reported-by-runtime` |
| `unknown` | input or output tokens missing (`tokens_missing`); provider/model unknown (`model_unknown`); no price for (provider, model) at the record time (`price_missing`); cache tokens without a cache price (`cache_price_missing`) | none (a gap) | `unknown` |
| `estimated` | otherwise | tokens × price table | `estimated-from-tokens` |

- A dollar value with any other provenance (e.g. a worker-side "estimate") is stored for forensics but not
  trusted; the master estimates from **its own** price table. Codex (tokens only) therefore becomes
  `estimated` once a price exists and `unknown/price_missing` until then.
- Estimates are computed **at read time** from the current price-table version (the stored record keeps the
  raw facts), so adding a missing price fixes past gaps; each response states `priceTableVersion`.
- Price selection: exact (provider, model) match, the entry with the latest `effectiveFrom ≤ recordedAt`.
  No prefix or alias matching (that would be a guess).
- Subscription runs report a runtime "cost" (e.g. Claude SDK `total_cost_usd`); it is an API-equivalent
  estimate, not money spent, so it is not shown as dollars anywhere.

## 4. Storage (migration 0009)

- `usage_records` — append-only (UPDATE/DELETE/TRUNCATE rejected, `RA000`). Job, attempt, worker,
  project (denormalised from the immutable `jobs.project`), runtime (from the job spec), runtime version
  (transport context or job spec), provider/model (event, else transport context, model else job spec),
  auth mode, token counts, turns, wall time, `cost_usd` + `provenance` **as reported**, `source_event_id`,
  `payload_hash`, `recorded_at` (master clock). `UNIQUE (attempt_id, source_event_id)`.
- `usage_price_tables` / `usage_prices` — every save is a complete new version (`version = max + 1`
  enforced by trigger; append-only). Version 0 is the implicit empty table: **the platform ships no prices**.
  Each entry needs a `source` (price page, invoice, contract).
- `usage_budgets` — definitions; updates must bump `version` by one; soft delete only; deleted rows are
  immutable.
- `usage_budget_alerts` — one row per (budget, budget version, window start, level); append-only.

## 5. Ingestion and budgets

`UsageStore.recordUsage(event, ctx)` — called by the worker transport when `EVENT{kind:'usage'}` arrives
(`ctx` = `jobId`, `attemptId`, authenticated `workerId`, `sourceEventId` = envelope `messageId`, optional
runtime version / auth mode / provider / model the transport knows). In one transaction:

1. Validates the event against the protocol schema and the ids; the attempt must belong to the job and
   have been run by `workerId` (another worker cannot attribute usage to it). Usage from an attempt that is
   no longer current is still accepted — the tokens were spent.
2. `INSERT … ON CONFLICT (attempt_id, source_event_id) DO NOTHING`. A replay returns the stored record
   (`duplicate`); a replay with different content (different `payload_hash`) is `conflicting`, audited
   (`usage.record.conflict`) and never applied. Concurrent replays insert exactly once.
3. Evaluates every enabled budget covering the record (global / project / runtime / worker / provider) for
   its window, and for each level reached (`warning` ≥ 80 %, `exceeded` ≥ 100 %, by **known** consumption)
   inserts the alert row; only the insert that wins writes the outbox row (`usage.budget.threshold`) and the
   audit event (`usage.budget.threshold`, system actor). Each crossing is announced once per
   (budget version, window); editing a budget starts a fresh alert series.

Rejections throw `UsageRejectedError` (`invalid_event`, `invalid_context`, `attempt_not_of_job`,
`worker_mismatch`) and are audited as `usage.record` / `denied`.

**Budget evaluation** (`evaluateBudget` in `@remyral/usage`, exposed as `UsageStore.evaluateBudget(id, at)`
and `evaluateBudgetsFor({project, runtime, worker, provider}, at)` for p4-quotas): metric `tokens`
(input + output; cache tokens excluded), `turns`, `wall_time_ms` or `cost_usd`; scope `global | project |
runtime | provider | worker`; calendar window `day | week (Mon–Sun) | month`, UTC.

| Status | Meaning |
| --- | --- |
| `under` | complete data, < 80 % |
| `warning` | complete data, ≥ 80 % and < 100 % |
| `over` | known consumption alone ≥ 100 % (true even with gaps: a lower bound suffices) |
| `unknown` | some records lack the metric and the known part is < 100 % — never reported as safe |

Dollar budgets: `unknown`-class records make the figure incomplete; `subscription` records count as zero
dollars and do **not** make it incomplete (they cost nothing per run — budget them by tokens/turns/time).

Not here: stopping or pausing jobs (p4-quotas consumes the outbox/evaluation), `provider_usage_limit`
failure handling (ADR-0014 §5; job/transport side), rolling windows.

## 6. API

| Route | Role | Notes |
| --- | --- | --- |
| `GET /usage/summary?groupBy=project\|worker\|runtime\|provider\|model&from=&to=&project=&worker=&runtime=&provider=&model=&authMode=` | viewer+ | default last 30 days up to now; max range 400 days. Per group and totals: records, tokens (in/out/cache), turns, wall time, `costUsd {reported, estimated, total}`, `coverage` counts and `coverageShare` per class, `unknownReasons`, `missingPrices [{provider, model, reason, records}]`, `flags {costComplete, hasSubscription, noPerRunCost, metricsIncomplete}`, `priceTableVersion` |
| `GET /usage/records?from=&to=&job=&…filters&limit=&cursor=` | operator+ | newest first, keyset cursor over `(recorded_at, id)`; each record with `reported {costUsd, provenance}` and derived `cost {costClass, costUsd, provenance, unknownReason, priceEffectiveFrom}` |
| `GET /usage/prices?version=` | viewer+ | current or a given version |
| `GET /usage/prices/versions` | viewer+ | history |
| `PUT /usage/prices` | admin+, step-up, CSRF | `{expectedVersion, note?, entries[]}` → new version; 409 on a stale version |
| `GET /budgets`, `GET /budgets/:id` | viewer+ | with current-window evaluation |
| `POST /budgets` | admin+ (owner/admin), step-up, CSRF | 201 with evaluation |
| `PUT /budgets/:id` | admin+, step-up, CSRF | `expectedVersion` (409 on conflict) |
| `DELETE /budgets/:id?expectedVersion=` | admin+, step-up, CSRF | soft delete |

Record-level detail is operator+ (it exposes job/attempt/worker per event); aggregates are viewer+.
All writes are audited (`usage.prices.update`, `usage.budget.create|update|delete`, success and denied with
the error code only).

## 7. Console

`/usage` (one nav entry "Usage"): **Overview** — period picker (24 h, 7/30/90 days, this month), group-by
switch, totals (known cost with "≥" when incomplete, tokens, turns, agent time), a dependency-free bar chart
(cost or tokens; values printed as text, bars decorative; incomplete groups highlighted) and an accessible
table (`caption`, `scope` headers) with coverage badges **runtime-reported / estimated / unknown /
subscription** and counts; "no per-run cost" for subscription-only groups; a "price missing" notice listing
(provider, model). **Prices** — read-only for everyone; admins edit rows (provider, model, effective date,
input/output/cache prices, source), prefill missing pairs, save a new version through step-up. **Budgets** —
status badge (under/warning/over/unknown), usage bar and "at least …" wording when incomplete; admins create,
edit and delete through step-up. No chart library was added (bars are CSS widths).

## 8. Security review

| Threat | Mitigation | Test |
| --- | --- | --- |
| Worker forges usage for another worker's attempt (T-WRK-3) | `workerId` comes from the authenticated connection; attempt must belong to the job and to that worker; rejections audited | integration "rejects another worker, a foreign attempt" |
| Duplicate/replayed events inflate costs (at-least-once delivery) | `UNIQUE (attempt_id, source_event_id)` + `ON CONFLICT DO NOTHING`; conflicting replays audited, not applied | integration concurrent replays, conflicting replay |
| Tampering with usage history or prices (T-OPS-3) | append-only triggers on records, price tables, prices, alerts; budgets soft-delete only; hash-chained audit for every write | integration trigger tests, `verifyChain` |
| Under-reporting makes a budget look safe (T-OPS-2) | `unknown` status whenever coverage is incomplete; `over` from known lower bound; costs never default to 0 | unit budget tests, integration dollar budget `unknown` |
| Invented prices presented as facts | ships an empty table; every entry needs a `source`; estimates labelled `estimated-from-tokens` with the price version | integration price versioning; UI "price missing" |
| Privilege misuse | price/budget writes admin+ with fresh step-up and CSRF; records operator+; role checks in the store, step-up in route and store | integration authorization tests; route-coverage test |
| Injection | group-by column from a whitelist map; all values bound parameters; strings validated by regex; UI renders worker-supplied strings as text | unit/integration; web test with hostile key |
| Secrets (T-SEC-1) | events carry counts, ids and auth *mode* only (ADR-0014: never the credential); free text limited to price `source`/`note`/budget `name` (admin input, length-capped) | review |
| DoS via large queries | summary range ≤ 400 days, records page ≤ 500, price table ≤ 1000 entries, request body limit | unit limits |

Residual risks: provider/model strings are worker-reported and only format-checked (a compromised worker can
misattribute *its own* usage); budget evaluation runs one aggregate query per covering budget per usage event
(fine for tens of budgets; p4-quotas may cache); no per-project human scoping of usage reads yet (projects
arrive with p5). Rollback: the migration is additive (new tables only); removing the route plugin disables the
API without affecting jobs; the protocol fields are optional.

## 9. Operations

Metrics hooks for p6-otel: records ingested, duplicates, conflicts (audit `usage.record.conflict`), threshold
alerts (`usage.budget.threshold`), share of `unknown` cost per day. Runbook: a "price missing" notice → an
admin adds the (provider, model) price with its source on Usage → Prices; historic estimates update at once.
