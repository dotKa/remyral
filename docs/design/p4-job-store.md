# Design note: job state machine and transactional job store (P4)

- **Status:** Implemented
- **Date:** 2026-10-13
- **Backlog:** p4-job-store (prepares p4-leases, p4-dispatch, p4-recovery, p4-dag, p4-approvals)
- **Decisions applied:** ADR-0003 (Postgres is the source of truth, transactional outbox, explicit
  transition table), ADR-0004 (leases, fencing epochs, retry policy), ADR-0010 (approvals are human-only)
- **Threat model:** T-OPS-1 (duplicate side effects), T-OPS-3 (tampering / repudiation)
- **State machine reference:** [p4-job-state-machine.md](p4-job-state-machine.md) (generated diagram + table)

## 1. Components

| Piece | Where | Responsibility |
| --- | --- | --- |
| `@remyral/scheduler` | `packages/scheduler` | Pure, DB-free state machine: `JOB_STATES` (14), `JOB_TRIGGERS` (25), `TRANSITIONS` (41 rules with allowed actors and guards), `decide(from, trigger, ctx)`, attempt helpers, Mermaid/Markdown rendering. No dependencies. |
| Migration `0003_jobs.sql` | `apps/master/migrations` | `job_state` enum, `jobs`, `job_attempts`, `leases`, `job_transitions`, `job_dependencies`, `outbox`, invariant triggers. |
| `JobStore` | `apps/master/src/jobs` | The only writer of those tables: `create`, `transition`, `acquireLease`, `renewLease`, `releaseLease`, `findExpiredLeases`, `addDependency`, plus reads (`get`, `history`, `attempts`, `leases`). |
| Outbox contract | `apps/master/src/jobs/outbox.ts` | `job.transition` topic and the Zod schema of its payload, for the p4-dispatch relay. |

No REST endpoints (p5-rbac-api) and no BullMQ (p4-dispatch) yet.

## 2. State machine

States follow ARCHITECTURE.md. Design choices beyond the architecture text:

- **Guards in the table.** Every rule lists the actor types that may cause it, whether a reason is
  mandatory, and whether a retry-safe assertion is mandatory. `decide()` returns a typed rejection
  (`terminal_state`, `no_transition`, `actor_not_allowed`, `reason_required`, `retry_not_safe`).
- **Cancellation** is immediate where no worker can be acting (DRAFT, QUEUED, BLOCKED, RETRY_WAIT,
  AWAITING_APPROVAL) and goes through CANCELLING + `cancel_confirmed` once a worker may be acting.
- **Lease loss → LOST, always.** From LOST only reconciliation decisions (`reconcile_resume`,
  `reconcile_finished`, `reconcile_retry` with retry-safe assertion, `reconcile_fail`) or
  `cancel_requested` are allowed, all by `user`/`system` with a reason. There is no LOST → QUEUED edge;
  rescheduling goes LOST → RETRY_WAIT → QUEUED and therefore always passes the retry-safe guard
  (ADR-0004 §5). The store additionally allows `reconcile_resume` only for the worker of the lost attempt.
- **Verification** ends in AWAITING_APPROVAL (`verification_passed`) or, when the job's policy needs no
  human approval, directly in SUCCEEDED (`verification_passed_no_approval`). The approval policy itself
  is p4-approvals; the state machine only guarantees approvals come from a `user`.
- **Attempts.** RESERVED, STARTING, RUNNING, VERIFYING, CANCELLING and LOST are "attempt-open". Only
  `reserve` enters that set (a new attempt); leaving it ends the attempt with an outcome derived from the
  target state (`succeeded`, `failed`, `cancelled`, `retry`, `declined`).

The table is tested exhaustively: all 14 × 25 = 350 (state, trigger) pairs against an independently
written specification, every guard against every actor, reachability (every state reachable from DRAFT,
a terminal state reachable from every state), and the ADR-0003/0004 properties above.

## 3. Data model (migration 0003)

| Table | Key columns | Invariants (DB-enforced) |
| --- | --- | --- |
| `jobs` | `id` uuid, `project`, `spec` jsonb, `state job_state`, `priority` (−100..100), `version`, `lease_epoch`, `current_attempt_id`, `created_by_type/id`, timestamps | Every UPDATE increments `version` by exactly 1; terminal rows are immutable; `lease_epoch` never decreases; identity columns immutable; `spec` immutable after DRAFT; `current_attempt_id` must be an attempt of this job (deferred FK). |
| `job_attempts` | `id`, `job_id`, `number` (unique per job), `worker_id`, `state` (`active`/`lost`/`ended`), `outcome`, `started_at`, `ended_at` | At most one non-ended attempt per job; `ended` ⇔ outcome ⇔ `ended_at`; ended rows immutable; no DELETE/TRUNCATE. |
| `leases` | `job_id`, `attempt_id`, `worker_id`, `epoch`, `acquired_at`, `expires_at`, `released_at`, `release_reason` | **At most one active lease per job** (partial unique index `WHERE released_at IS NULL`); `(job_id, epoch)` unique; a new lease's epoch must equal `jobs.lease_epoch` and exceed every earlier epoch of the job; worker must be the attempt's worker; identity columns immutable; released rows immutable; no DELETE/TRUNCATE. |
| `job_transitions` | `job_id`, `version`, `from_state`, `to_state`, `trigger`, `actor_type/id`, `reason`, `attempt_id`, `epoch`, `occurred_at` | Append-only exactly like `audit_events` (UPDATE/DELETE/TRUNCATE raise `insufficient_privilege`, revoked from PUBLIC); `(job_id, version)` unique, so a job's history has no gaps or duplicates; `from_state IS NULL` ⇔ `trigger = 'create'`. |
| `job_dependencies` | `(job_id, depends_on_job_id)` | No self-edges; **cycle check on insert** (recursive CTE under a transaction-scoped advisory lock, SQLSTATE `RA001`); edges immutable. |
| `outbox` | `id` (identity, relay order), `topic`, `job_id`, `payload` jsonb, `created_at`, `dispatched_at` | Rows immutable except setting `dispatched_at` once; only dispatched rows may be deleted; no TRUNCATE. |

Indexes: queued jobs by `(priority DESC, created_at)` (partial), jobs by state and by project, open
attempts by worker, active leases by expiry and by worker (partial), pending outbox by id (partial),
transitions by time, dependencies by target.

Invariant triggers raise SQLSTATE `RA000`. They are defence in depth: `JobStore` already enforces all of
them; the triggers make a buggy or hostile direct write fail loudly. As with `audit_events`, a role that
owns the tables can disable the triggers, so production runs the API under a non-owner role
(p1-data-services).

## 4. JobStore

### Transition algorithm (one Postgres transaction)

1. Read the job (no lock). `expectedVersion` mismatch → `VersionConflictError`.
2. `decide()` from `@remyral/scheduler` with the actor type, reason and retry-safe flag → otherwise
   `IllegalTransitionError`.
3. Worker actors: **fencing** — `epoch` must equal the job's current, unreleased, unexpired lease held by
   that worker (`StaleEpochError` with `superseded` / `released` / `expired` / `not_holder` /
   `unknown_lease`). `lease_expired` requires an active lease that has actually expired.
4. `UPDATE jobs … WHERE id = $1 AND version = $read` — this takes the row lock; of several transactions
   that read the same version exactly one updates a row, the others get `VersionConflictError` (zero rows
   after waiting for the winner). This is the optimistic-concurrency point; everything else depends on it.
5. Attempt bookkeeping (insert on `reserve`; `lost`/`active` on lease loss/resume; end with outcome when
   leaving the attempt-open states) and lease bookkeeping (close the active lease with the trigger as
   reason when the job leaves the executing states or goes LOST; insert the new lease on reserve/resume).
6. Append `job_transitions`, insert the `outbox` row, record `job.transition` in the audit chain with the
   same transaction (`AuditLog.record(event, tx)`).

Any error rolls everything back. Rejections (illegal transition, stale epoch, cycle, rejected dependency)
then record a `denied` audit event outside the rolled-back transaction (ADR-0003 §4: illegal
transitions are rejected and audited). Version conflicts are not audited (benign races).

`create` inserts the DRAFT row, its `create` history + outbox rows and `job.create` audit event, and with
`submit: true` applies `submit` in the same transaction. The spec is validated with the protocol
`JobSpec` (unknown keys stripped); `InvalidJobError` lists field paths and issue codes, never values.

### Leases (ADR-0004)

- `acquireLease(jobId, workerId, ttlMs)` — from QUEUED applies `reserve` (new attempt `n+1`); from LOST
  applies `reconcile_resume` (same attempt, same worker, reason required). Either way a lease with
  `epoch = jobs.lease_epoch + 1` is inserted in the same transaction. Racing workers: one wins, the others
  get `LeaseConflictError` (version check; the partial unique index is the backstop). TTL 1 s – 1 h.
- `renewLease(jobId, workerId, epoch, ttlMs)` — extends to `now + ttl`, never shortens. Rejects any epoch
  that is not the live lease of that worker; an expired lease cannot be renewed (it belongs to
  reconciliation).
- `releaseLease(jobId, workerId, epoch)` — stale epochs rejected; releasing a lease the store already
  closed is acknowledged idempotently (replays, ADR-0004 §4). In RESERVED/STARTING/RUNNING/CANCELLING the
  worker must instead report the transition that closes the lease (`lease_declined`, `attempt_failed`,
  `cancel_confirmed`, …), so a job never sits in an executing state without a lease
  (`LeaseReleaseRejectedError`). In VERIFYING (worker done, master verifies) release is allowed.
- `findExpiredLeases({now, limit})` — unreleased leases past expiry, oldest first, with the job state:
  the input of the reconciliation loop, which then applies `lease_expired` (→ LOST) and a reconcile
  decision.

Lease tokens (Ed25519-signed), idempotency keys for worker messages and the reconciliation loop itself
are p4-leases / p4-dispatch / p4-recovery.

### Outbox contract (for p4-dispatch)

Topic `job.transition`, one row per history row (including `create`), payload
`{jobId, transitionId, version, from, to, trigger, attemptId, epoch}` (schema
`JobTransitionOutboxPayload`). The relay reads `WHERE dispatched_at IS NULL ORDER BY id`, publishes, then
sets `dispatched_at`. Consumers re-read Postgres; `version` lets them drop stale or duplicate events.

### Clock

The store takes an injected clock (as `AuditLog` does) and writes all timestamps from it; lease expiry
compares against it. Multiple master replicas must run with synchronised clocks (NTP), which the lease
TTLs (seconds) tolerate.

## 5. Tests

- `packages/scheduler/test/machine.test.ts` — exhaustive 350-pair matrix, guards per actor, reason and
  retry-safe guards, reachability, LOST/RETRY_WAIT properties, attempt outcome helpers.
- `packages/scheduler/test/diagram.test.ts` — Mermaid rendering and the generated doc is current.
- `apps/master/test/integration/jobs.test.ts` (throw-away database per run) — schema enum mirrors the
  scheduler; create/validation; happy path with history = outbox = audit; illegal transitions write
  nothing (snapshot of every table) but a denied audit event; terminal immutability (store + DB);
  expectedVersion; 8 parallel identical transitions and 4 different racing transitions on separate
  connections → exactly one winner; 6 workers racing for one lease → one lease, one attempt; stale/
  foreign/missing epochs on renew, release and worker transitions; renew never shortens; expiry → LOST →
  resume (epoch 2, same attempt) → LOST → reconcile_retry → retry_due → re-lease (epoch 3, attempt 2);
  release rules; decline; cancel with confirmation; DB backstops (second active lease, epoch rewrite,
  epoch decrease, version skip, lease delete); audit failure injected mid-transaction → no outbox, no
  history, no attempt/lease, epoch not consumed; outbox mutation rules; history UPDATE/DELETE/TRUNCATE
  rejected; ended attempts immutable; DAG accepted, cycles/self-edges rejected (store and direct insert),
  cross-project and started jobs rejected; concurrent A→B / B→A inserts → exactly one succeeds; audit
  chain verifies.

## 6. Security review

| Threat | Mitigation in this task | Residual / follow-up |
| --- | --- | --- |
| **T-OPS-1** duplicate side effects after reconnect/crash | Per-job monotonic fencing epoch issued in the same transaction as the attempt; DB enforces one active lease per job and strictly increasing epochs. Every worker-caused transition must carry the current live epoch of that worker, so a stale or partitioned worker cannot advance the job; stale renew/release are rejected and audited. Lease expiry only leads to LOST; rescheduling requires an explicit reconcile decision and a retry-safe assertion. Optimistic versioning guarantees one winner per job version, so two schedulers cannot both reserve a job. The outbox makes delivery at-least-once with a version for de-duplication. | Fencing of external side effects (git push, PRs) via the epoch in branch names/trailers is p4-git-flow; signed lease tokens and message idempotency keys are p4-leases; the reconciler is p4-recovery. Clock skew between master replicas affects expiry by at most the skew. |
| **T-OPS-3** tampering / repudiation | `job_transitions` is append-only at the DB level (same mechanism as `audit_events`), with gap-free per-job versions; every transition, lease grant/release, dependency change and every rejection is also in the hash-chained audit log in the same transaction (or right after a rollback for denials), with actor, trigger, epoch and reason. Jobs, attempts, leases and outbox rows carry immutability triggers. Approvals can only be made by `user` actors (ADR-0010). | A table owner can disable triggers; production uses a non-owner role (p1-data-services). History rows are not hash-chained themselves; the audit chain is the tamper-evident record. |
| T-CP-4 injection | Parameterised queries only; identifiers validated (uuid, protocol `WorkerId`, project pattern); reasons clipped to 1000 chars, NUL stripped. | — |
| Information leakage | Validation errors carry paths/codes only (canary test); audit metadata holds identifiers, trigger, reason — never the prompt or spec. | Reasons are free text from authenticated users/workers; p5 must not render them as HTML. |
| Availability | Transitions are short transactions; the audit advisory lock serialises appends (acceptable at job-transition rates, see p1 note). Cycle checks serialise dependency inserts only. | Revisit if transition throughput becomes a bottleneck (partitioned audit chains, new ADR). |

## 7. Rollback and operations

Forward-only migration: rolling back the build after 0003 ran requires a corrective migration (the runner
refuses unknown versions). 0003 only adds objects, so the previous build's code is unaffected except
for the downgrade guard. Operational signals for p6-otel: rate of `denied` job/lease audit events
(stale epochs indicate partitions or misbehaving workers), count of `findExpiredLeases()`, outbox backlog
(`dispatched_at IS NULL`).
