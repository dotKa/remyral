# p22-ops-hygiene — loops that never end, alarms that flap, an outage that floods the log, tables that only grow

Status: implemented (2026-11-02). Migration `0207_ops_hygiene.sql` (additive). No worker or protocol change.

## 1. Evidence (test server, master logs)

| # | Signal | Volume |
|---|---|---|
| 1 | `ops provider call failed` + `deploy status poll failed` — one `coolify.deploy` action `deploying` since 2026-10-30, polled every ~16 s, Coolify answers `deployment <uuid>: not found` | ~13 300 warnings each in 7 days |
| 2 | "Alarm/Resolved: Job queue backlog", "Job failure spike" | 63 + 39 flaps in 14 days |
| 3 | One Redis outage (2026-10-28): ~15 background sweeps logging errors, plus `unhandled error` "rate limiter: no answer from Redis within 1000 ms" | 1 063 error lines |
| 4 | `version catalog refused` (component update-channel) | 622 warnings in 7 days |
| 5 | `uptime_checks` 207 000 rows, `worker_inbox` 40 000 rows | growing |

## 2. Causes and changes

### 2.1 Deploy status poller (`apps/master/src/ops/service.ts` `pollDeploying`)

Cause: a provider error (any, including a permanent `not_found`) was logged and the action was polled again 15 s later,
forever; there was no maximum age except for `pages.add_domain` (24 h).

Change:
- **Not found is terminal.** `isNotFound` = an `OpsError` whose code ends in `_not_found` (`coolify_not_found`,
  `cloudflare_not_found`, a deleted connection). After `POLL_NOT_FOUND_LIMIT` = 3 consecutive answers the action fails
  through the usual `#finish` (audit `ops.action.execute` failure, outbox `ops.action` `failed` → deploy-failed
  notification, chat outcome, webhook `deploy.failed`) with "The provider no longer knows this deployment …".
- **Maximum age.** `DEPLOYING_MAX_MS` = 2 h from `COALESCE(decided_at, created_at)` (when execution started; approval
  waiting time is not counted) for every kind except `pages.add_domain`. An overdue action is claimed even in backoff,
  gets one last status poll (a deployment that did finish is still recorded as succeeded) and otherwise fails "Timed
  out: no outcome 2 hours after the deploy started …".
- **Backoff.** Transient errors set `next_poll_at` = now + 15 s · 2^(n−1), at most 5 min (or the provider's
  Retry-After); one warning when the trouble starts and every 10th try, debug in between. A successful poll resets
  `poll_errors` / `poll_not_found` / `next_poll_at`.
- **The stuck row heals itself:** on the first pass after deploy it is overdue (since 2026-10-30) → claimed → last
  poll answers not found → failed as timed out. No manual DB edit.

### 2.2 Alert hysteresis (`apps/master/src/alerts/evaluator.ts`)

Cause: a firing alert resolved on the first evaluation where its condition was absent. A queue that drains for a
minute and backs up again produced Alarm → Resolved → (cooldown 30 min) → Alarm again.

Change: a firing instance whose condition is absent records `alert_states.clear_since` and resolves only after the
condition stayed clear for `resolveAfterMs` (default 15 min; `clearDecision`). A condition that returns inside the hold
clears `clear_since` — no notification at all. The existing cooldown is unchanged: a re-raise within 30 min of a
resolve re-opens the same episode silently and its second resolution is not announced (dedupe key per episode).
`resolveAfterMs: 0` (master deps `alerts.resolveAfterMs`) restores the old behaviour; the existing rule tests use it.

### 2.3 Dependency-health gate (`apps/master/src/infra/dependency-health.ts`)

Cause: every background loop has its own `setInterval` + `catch → log.error`; during a Redis/Postgres outage each one
logged every pass. The rate limiter's bounded Redis call threw a plain `Error` that the HTTP error handler logged as
`unhandled error` with a 500.

Change: one shared `DependencyHealth` (created in `compose.ts` `beforeRoutes`):
- `dependencyOf(err)` recognises Redis (our bounded-wait message, ioredis offline/max-retries errors, port 6379) and
  Postgres (SQLSTATE 57P0x/08xxx/53300, pg connection messages, port 5432) outages, following `cause`.
- A recognised error is **confirmed by a probe** (`PING` / `SELECT 1`, 1 s bound). Only a failed probe marks the
  dependency down: one **warn** on the transition; one **info** "available again" (with the downtime) when a probe
  succeeds. Probes back off 1 s → 30 s while it stays down (background loop every 1 s, a no-op while all is up).
- Sweeps: `gated(name, fn)` (`health.run`) for the loops `compose.ts` owns (worker heartbeat sweep, outbox relay, chat
  turn sweep, live retention, related work, release uploads / channel poll, ops-safety passes) and for **every
  orchestrator tick step** (new optional `OrchestratorDeps.gate`, wrapping `#step`; covers ops polling, uptime,
  update channel, catalog, …). A sweep that failed on a down dependency is skipped with one debug line per outage until
  the dependency answers. Self-scheduled services (`approvals`, `notifications`, `search` indexer, chat knowledge,
  memory suggestions / records, context retention, doctor, webhooks-out, alerts, metrics tail) keep their own timers;
  their `onError` goes through `gatedError` (`health.onError`): a dependency failure is a debug line, anything else is
  logged exactly as before. (Making those skip too would mean touching ten services; their passes fail fast while a
  dependency is down, so the log volume is what mattered.)
- **Rate limiter: fail-closed stays** (ADR-0009 §7, p7-rate-limit, p11-fixes-a): the request limiter
  (`FallbackRateLimiter`) still falls back to per-process windows, and its once-a-minute warning is now the health
  gate's single transition warning. Every other limiter use — credential attempts (`AuthService`), pairing, chat turns,
  uploads, … — keeps failing closed, but `RedisRateLimiter` now throws `DependencyUnavailableError('redis')` and the
  error handler answers any dependency outage with **503 `dependency_unavailable` + `Retry-After: 5`** (i18n key in
  TR + EN), reported to the gate (logged once per transition, debug per request) instead of `unhandled error` + 500.
  Nothing is allowed that was refused before.

### 2.4 `version catalog refused` (`apps/master/src/update-channel/catalog.ts`)

Cause: the host-cached copy is re-read every 5 min (URL every 6 h). A catalog the master cannot accept (no trusted
catalog key yet, `unknown_key`, …) was refused — and warned **and audited** — on every read of the same bytes.

Change: a refusal is reported (warn + audit `update_channel.catalog.refused`) once per distinct (reason, detail,
document SHA-256); the same refusal again is a debug line. A new document or a new reason is reported again; the
status (`status().error`) is unchanged. Memory is bounded (100 entries, then cleared); a master restart reports once.

### 2.5 Retention

**`uptime_checks` → 7 days** (`LIMITS.checkRetentionDays`, was 30). Readers of the raw rows: the 24 h chart
(5-minute buckets) and the raw check list (`checksPage`). Uptime % (24 h / 7 d / 30 d) and the 7/30/90-day charts read
`uptime_rollups` (hourly, kept 90 days, maintained with every check), so nothing shown is lost except raw rows older
than a week in the check list. Prune: `DELETE … WHERE id IN (SELECT … WHERE at < $1 ORDER BY at LIMIT 5000)`, at most
40 statements per hourly pass (uses `uptime_checks_at_idx`); the first passes after deploy work the backlog off.

**`worker_inbox` → 7 days for processed rows** (`src/orchestration/inbox-retention.ts`, hourly tick step
`inbox-retention`, 5 000 rows × at most 20 per pass, oldest id first). Checked before choosing the age:
- replay / exactly-once dedupe does **not** read the journal: the per-worker cursor `workers.last_worker_seq` refuses
  seq ≤ cursor and `worker_processed_messages` holds the bounded messageId window (p2-transport §34); the unique
  `(worker_id, seq)` cannot be hit again by a pruned row because its seq is below the cursor (also after a standby
  restore: renumbering follows the restored cursor, p11-master-resilience §5);
- effect retries (`Orchestrator.retryEffects`) need rows with `effect_status` `pending` / `running` → **never pruned**;
- the output report (`GET /jobs/:id/output-report`, p17-output-limits) reads rejected `ARTIFACT_REF` rows → **kept**
  (few rows; they explain a missing output for as long as the job is shown);
- live view, events, logs, results and artifacts are in their own tables; the raw journal is otherwise diagnostics.

## 3. Tests

- `apps/master/test/unit/dependency-health.test.ts` — classification; one warn / one info per outage; sweeps skip with
  one debug line each; a misclassified error (probe succeeds) is rethrown / logged as before; probe backoff; a probe
  without an answer; the Redis limiter's `DependencyUnavailableError`, the fallback limiter, the error handler's 503 +
  Retry-After with a single warning.
- `apps/master/test/unit/ops-hygiene.test.ts` — poll backoff, `isNotFound`, `clearDecision` / `withinCooldown`, catalog
  refusal dedupe (warn + audit once per document and reason), inbox retention batches and hourly throttle.
- Integration (Postgres; written, run by the main agent after the merge):
  `ops-poll-hygiene.test.ts` (3 not-found answers fail the action with the outbox `failed` row; backoff and reset;
  an overdue stuck row in backoff fails as timed out), `alerts-hysteresis.test.ts` (brief clear → no notification;
  15 min clear → one "Resolved"; re-raise in the cooldown silent), `retention-hygiene.test.ts` (12 000 old uptime
  checks pruned across batches, rollups kept; inbox: pending effect, rejected `ARTIFACT_REF` and recent rows kept).
  `alerts.test.ts` and `agentmagnify.test.ts` pin `resolveAfterMs: 0` (they test the rules / blockers, not the hold).

## 4. Security, rollback

- No security default is loosened: fail-closed limiter paths still refuse (503 instead of 500); the request limiter's
  per-process fallback is unchanged. 503 bodies are the generic text, no error details.
- Audit: deploy failures by not-found / timeout go through the normal audited `#finish`; repeated identical catalog
  refusals are no longer re-audited (the first one is).
- Rollback: an older master ignores the new columns (migration additive; drop statements in the migration header).
  Raw uptime checks / inbox rows deleted are gone (rollups remain) — intended.

## 5. Not done / unverified

- The self-scheduled services listed in §2.3 still run their passes during an outage (errors absorbed, not skipped).
- Not exercised against a real Redis pause on the test server; verify after deploy that a `docker pause` of Redis gives
  one warn + one info and 503s on login instead of `unhandled error`.

## Changelog

- fix(master,i18n): **a deploy whose deployment the provider forgot ends instead of being polled forever, alarms stop flapping, a Redis outage is one warning instead of a thousand errors, and old uptime checks / worker journal rows are pruned** (p22-ops-hygiene, [design](p22-ops-hygiene.md); evidence test server: 13 300 `deploy status poll failed` warnings a week for one action deploying since 2026-10-30, 102 alarm flaps in 14 days, 1 063 error lines from one Redis outage, 622 `version catalog refused` a week, 207 000 `uptime_checks` rows). The deploy poller fails an action after 3 "not found" answers or 2 h without outcome (the stuck row heals on the first pass) and backs off up to 5 min on provider errors; an alert resolves only after 15 min clear; a shared dependency-health gate logs a Redis/Postgres outage once each way, sweeps skip while it is down, and fail-closed rate limits answer 503 `dependency_unavailable` with Retry-After instead of a 500; a repeated identical catalog refusal is debug; raw uptime checks are kept 7 days (rollups 90) and processed `worker_inbox` rows 7 days (pending effects and refused outputs kept). Migration 0207.
