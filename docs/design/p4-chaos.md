# Design note: P4 chaos suite — crashes, duplicates, lease loss, master/Redis/Postgres outages

- **Status:** Implemented
- **Date:** 2026-10-13
- **Backlog:** `p4-chaos` — "Crash/duplicate/lease-loss/Redis-restart test suite" (acceptance **A-ORCH-3** crash
  during lease ownership reconciles safely, **A-ORCH-6** queue survives master/Redis restart; P4 gate: multi-worker
  concurrency, simulated crashes create no silent duplicate commits, protected merge requires approval).
- **Decisions exercised:** ADR-0003 (Postgres is the source of truth, Redis only carries hints), ADR-0004 (leases,
  fencing epochs, idempotency, LOST → reconciliation, retry only when verified safe), ADR-0005 (revocation),
  [p4-orchestration.md](p4-orchestration.md), [p4-git-flow.md](p4-git-flow.md), [p2-transport.md](p2-transport.md).
- **Threat model:** T-OPS-1 (duplicate side effects after reconnect/crash), T-WRK-2 (stale/forged worker
  results), T-OPS-3 (repudiation: every refusal is audited).

## 1. How to run

```sh
pnpm dev:up        # the dev Postgres/Redis (throw-away databases only; the `remyral` DB is never touched)
pnpm chaos         # builds @remyral/worker + deps (the SIGKILL scenarios run a worker as its own OS process),
                   # then apps/master/test/chaos/**/*.chaos.ts, then removes containers labelled remyral.chaos=1
pnpm chaos --skip-build -- -t "SIGKILL"   # reuse dist/, filter scenarios
```

Needs Docker (throw-away `redis:8.10.2-alpine` / `postgres:18.6-alpine` containers on free loopback ports — the
same images as the dev stack, so nothing is pulled). Hints use Redis logical DB 13 of the dev Redis, never DB 0.
**Not part of `pnpm verify`:** a full run takes 1.5–2 min on an idle machine but up to 30 min under heavy load (§5), needs Docker, and restarts containers and kills processes.
CHAOS_LOG_LEVEL=debug raises the master log level; on a failure each scenario writes the job histories, every
worker's log and the master log to `$TMPDIR/remyral-chaos-<suite>-<ts>.log` (no secrets: test credentials only).

## 2. Harness and invariants

`apps/master/test/chaos/helpers/`

| File | Role |
| --- | --- |
| `cluster.ts` | `ChaosCluster` (extends the integration `Harness`): a real master (`createMasterApp`: Fastify, Postgres, BullMQ hints, background loop every 50 ms, git flow with `LocalGitProvider` on a local bare repository) that can be **stopped and started again on the same database, port and lease-signing key**; in-process worker daemons (real `WorkerDaemon` + `JobRunner` + `WorkspaceManager` + WebSocket transport) and **out-of-process workers** (`ProcessWorker`); fake master clock (leases expire only when a scenario says so: `expireLeases()`, `pastGrace()`). |
| `fixtures/worker-process.mjs` | The same worker stack from the built packages in its own process, so `SIGKILL` is a real power loss. Modes: `drop-result` (JOB_RESULT frames never reach the socket — a partition after the push; the message stays in the durable outbox), `stall-seq` (the master sequence number after an ASSIGN_JOB never reaches the disk — slow disk), prompts with `hold-forever` never finish. |
| `adapter.ts` | `ChaosAdapter`: fake runtime that writes `edit <file> <text>` into the worktree (so every attempt commits and pushes), holds a job's result on demand (abort-aware), and records **every runtime spawn** in a shared `SpawnLedger` (also fed by the process workers' stdout). |
| `docker.ts` | `ThrowawayContainer` (`start`, `pause`, `unpause`, `restart`, `remove`) with a fixed free host port (an ephemeral mapping can move on restart). |
| `invariants.ts` | The shared checker below. |

Every scenario ends with `assertInvariants()`, which polls `checkInvariants()` until it returns no violation
(structural ones never heal, so polling only waits for convergence: outbox drained, leases released):

1. **State machine legal** — each job's history is gap-free (`version` 1..n), starts with `create`, every step
   is a rule of `@remyral/scheduler`'s table with an allowed actor type, chains `from = previous to`, ends in
   the job's current state and version.
2. **Audited** — one `job.transition` audit record per transition after `create`; the hash chain verifies
   (`verifyChain`); every stale (fenced) worker message has a `job.message` denial with `stale_epoch`.
3. **No duplicate execution** — at most one applied `JOB_RESULT` and one `runtime_started` per attempt, at most
   one succeeded attempt per job (the scenarios also check the spawn ledger: one runtime spawn per attempt).
4. **No duplicate commits on the remote** — over every branch of the bare repository, at most one commit carries
   the `Remyral-Attempt: <attempt>/<epoch>` trailer of any attempt; a verified job's head carries exactly the
   job's current attempt/epoch; every merge on the target was approved (`git_merge_requests` → approved
   approval request).
5. **No orphan leases/attempts** — an unreleased lease belongs to the job's current attempt and epoch in a
   lease-holding state (RESERVED, STARTING, RUNNING, CANCELLING, VERIFYING); no open attempt on a terminal job.
6. **Outboxes drained** — no undispatched `job.transition`/`approval.decision` rows; connected workers' master →
   worker outboxes acknowledged; no pending inbox effects.

## 3. Scenarios

| # | File | Scenario | What is asserted beyond the invariants |
| --- | --- | --- | --- |
| 1 | `crash.chaos.ts` | Worker **process SIGKILLed** mid-run → lease expiry → LOST → (grace) → branch absent on the remote → `reconcile_retry` on another worker; the crashed machine powers on again | lost attempt: 0 commits, 1 spawn; retry: 1 commit; the restarted worker drops its restored lease, does not rerun, and its answer to the durable CANCEL_JOB is refused as stale |
| 1b | `crash.chaos.ts` | **Partition** while running → LOST → the worker reconnects with the run → `reconcile_resume` under epoch 2 | one attempt, one commit (trailer `/2`), one spawn |
| 1c | `crash.chaos.ts` | Crash between ASSIGN_JOB admission and the cursor write (`stall-seq`, then SIGKILL) → the master replays ASSIGN_JOB to the restarted process | the attempt is **not run again** (finding F1), the master reconciles it to a retry |
| 2 | `partition.chaos.ts` | **Partition after the push, before JOB_RESULT reaches the master** (`drop-result` + SIGKILL), restart while the lease lives | exactly one applied result, one commit, no retry |
| 2b | `partition.chaos.ts` | Same, but the lease expires meanwhile (LOST) | the late result is recorded (`stale: lease_expired`) and reconciled (`reconcile_finished` → verified), never `reconcile_retry` (finding F2) |
| 3 | `partition.chaos.ts` | **Duplicate ASSIGN_JOB** ×3, **duplicate outbox rows/hints** (relay crash between publish and mark), hint/dispatch storms, **duplicate JOB_RESULT frames** (byte-identical replay and same result as a new message, on the worker's own key) | one reserve, one runtime session, re-acks only; identical frame deduplicated, new one journaled `rejected`, no transition |
| 4 | `partition.chaos.ts` | **Stale vs current epoch**: A is cut off from the master (not from git), the job is retried on B (epoch 2); A finishes, pushes its own branch and replays its result after a restart | A's result `stale: superseded` + audited denial; verification and the approved merge take B's commit; main never contains A's |
| 4b | `partition.chaos.ts` | **Multi-worker concurrency**: 9 jobs on 3 workers under hint storms | each job: one attempt, one spawn, one commit; spread over workers |
| 5 | `restart.chaos.ts` | **Master restart** (Fastify app closed, new instance on the same DB/port) with two running jobs (one finishing while the master is down), one queued behind a full worker, one **half-dispatched** (lease granted, ASSIGN never queued) | the offline result is replayed and verified; the queued job is dispatched by the new master; the half-dispatched one: RESERVED → LOST → "never started" → retry; nothing spawned twice |
| 5b | `restart.chaos.ts` | **Redis FLUSHALL** (throw-away container used for rate limits and hints) between submit, run and cancel | one reserve and one spawn per job; cancel still delivered |
| 5c | `restart.chaos.ts` | **Redis container paused, then `docker restart`** (all keys lost) | `/readyz` 503 during the outage and 200 after; a job submitted during the outage runs (Postgres loop) |
| 6 | `postgres.chaos.ts` | Throw-away **Postgres container paused** a few seconds while a run finishes | `/readyz` 503 then 200; the result produced during the outage is applied exactly once afterwards |
| 6b | `postgres.chaos.ts` | **`pg_terminate_backend`** of every connection of the master's database, five times, while two runs report | master stays up (finding F3), both jobs converge, one attempt/commit each |
| 7 | `conflict.chaos.ts` | Two jobs on two workers edit the same file; **master restart between the merge request and the approval**; stale step-up refused; second job conflicts; third job's attempt head moved by a zombie after the request | merge only after approval + step-up; conflict reviewable (`conflicts`, `README.md`), merge request 409 `merge_conflicts`; moved head → `refused: head_moved`, main untouched |
| 8 | `crash.chaos.ts` | **Revoked mid-job** | socket closed, worker quarantined and refused on reconnect (`ERROR revoked`); job LOST → retried on a healthy worker; the revoked machine's run produces nothing accepted |

## 4. Findings (fixed, each with a regression test)

| # | Bug | Fix | Regression tests |
| --- | --- | --- | --- |
| F1 | **A restarted worker re-ran an attempt it had already admitted.** If the daemon died after admitting an ASSIGN_JOB (lease on disk, LEASE_ACK queued, runtime possibly started) but before recording the master's sequence number, the master replayed ASSIGN_JOB after the restart; the daemon dropped the restored lease at session start and then admitted the replay as new — a second execution of the same attempt (ADR-0004 §5 "never a blind rerun"). In the chaos run the rerun happened to fail on the existing worktree and turned the job FAILED instead of being reconciled. | `JobRunner.onSessionEstablished` remembers every dropped restored lease as already run here; the replayed ASSIGN_JOB is ignored and the master reconciles (lease expiry → LOST → the connected worker does not run it → retry if safe). `apps/worker/src/jobs/runner.ts` | `apps/worker/test/job-runner.test.ts` "a replayed ASSIGN_JOB for a lease restored from a crashed run is never run again"; chaos 1c |
| F2 | **A late JOB_RESULT could lose the race against the worker's first heartbeat.** On a new session the daemon started telemetry (CAPABILITIES + HEARTBEAT with an empty running-jobs list) before replaying its durable outbox. The master treats the first heartbeat as authoritative for LOST jobs and decided retry/fail before the replayed result was routed: with a pushed branch the job failed "needs human review"; with no push (no changes, or a project without git flow) it would have been **retried — a duplicate execution of a finished job**. | `WorkerDaemon` replays the outbox before it starts telemetry on a new session (one socket keeps the order, and the master processes a connection's frames in order). `apps/worker/src/daemon/daemon.ts` | `apps/worker/test/replay.test.ts` "replays the durable outbox before the first HEARTBEAT of a session"; chaos 2b |
| F4 (p11-fixes-a, 2026-10-19) | **Every request hung while Redis was paused; `/readyz` never answered 503.** A paused container keeps its TCP socket open, so ioredis never sees a disconnect: `enableOfflineQueue: false` does not apply and commands wait for an answer forever (no command timeout). The per-IP request limiter (an `onRequest` hook on every route, `/readyz` included) awaited its `MULTI` before any handler ran; `FallbackRateLimiter` only fell back on an error, which never came. Scenario 5c failed at "readiness fails" — the poll's requests never returned. | `RedisRateLimiter` waits at most 1 s (`bounded`), then throws: the request limiter falls back to per-process windows and does not ask Redis again for 5 s (no pile-up); credential limits still fail closed. `/readyz` and `/status` PING with their own 1 s timeout (`redisProbe`). The client's own command behaviour is unchanged. `apps/master/src/auth/rate-limit.ts`, `apps/master/src/routes/health.ts` | `apps/master/test/unit/rate-policy.test.ts` "an unresponsive Redis …"; chaos 5c (`restart.chaos.ts`, now passing) |
| F3 | **The master crashed on a Postgres connection loss.** A checked-out pg client that loses its backend between queries (the dispatcher holds one for its advisory lock; transactions wait on other work) emits `error`; only idle clients had a listener, so it became an uncaught exception. | `createPool` attaches an `error` listener to every client on connect; the next query on it rejects and the caller's error path rolls back/releases. `apps/master/src/db/pool.ts` | `apps/master/test/integration/db-pool.test.ts`; chaos 6b |

## 5. Results

Measured on the development machine (MacBook Air, Apple silicon, Docker Desktop 29.6.2), 2026-10-13.

| Run | Load average | Result | Wall time |
| --- | --- | --- | --- |
| Full `pnpm chaos` #1 (with build) | 45–90 (other agents' suites) | 13/15 — 6b failed (a worker left running by the previous scenario took the job; fixed: `endScenario()` stops every worker between scenarios), 5c failed (job submitted during the Redis pause still VERIFYING at the 30 s poll bound) | ≈ 30 min |
| `restart.chaos.ts` ×3, Redis scenarios ×2 (after merging `main`) | 5–15 | all passed | 1–2 min each |
| Full `pnpm chaos` #2 (`--skip-build`) | 5–15 | **15/15** | 84 s |
| Full `pnpm chaos` #3 (`--skip-build`) | 5–15 | **15/15** | 107 s |

Scenario 5c's failure did not reproduce in five later runs. The job had reached `run_finished → VERIFYING`.
While Redis is paused, every loop pass first waits up to 2 s for the hint publish to time out, so at load 90 the
git-flow verification pass ran too rarely to finish within the 30 s bound. The chaos poll bound is now 90 s (the
test polls state; nothing sleeps). If it comes back, the next step is to measure loop-pass latency during a Redis
outage: the relay could skip publishing while the Redis client is known to be down (rows stay pending) instead of
paying the 2 s timeout on every pass. This is an open observation, not a fixed bug.

## 6. Deflaking of load-sensitive suites (part of this task)

Root causes fixed (no timeouts raised blindly; poll upper bounds were raised only where the test waits for a
state, never for a fixed sleep):

| Suite | Root cause | Fix |
| --- | --- | --- |
| `notifications.test.ts` "worker offline while holding a lease" | The harness's master ran the background heartbeat sweeper every 5 s; when it fired between the test's inserts and its own `sweep()`, the test's call returned without the worker. | `workers.sweepIntervalMs: 0` disables the background sweeper (`compose.ts`); the integration `Harness` uses 0 unless a test sets it. |
| `worker-gateway.test.ts` timing | The steps the test answers had 200–300 ms budgets, and the challenge expiry (300 + 300 ms) raced the session expiry (600 ms). | Separate harness per timing test; answered steps get ≥ 2 s; the challenge outlives the session so an unanswered round deterministically ends as `session_expired`; the 4429 flood repeats bursts until the master closes. |
| `worker-replay.test.ts` burst | `disconnect()` was fire-and-forget: on a slow machine the whole burst was delivered before the drop, and `sessions ≥ 2` was read before the reconnect; a fixed 150 ms sleep stood in for "the duplicate was handled". | The drop is awaited mid-burst; the test polls for the second session; the duplicate check waits for the master's ACK. |
| `audit.test.ts` concurrent writers, `worker-identity.test.ts` rotation | No defect found (the chain is serialised by an advisory lock taken before the previous-hash read; the rotation test already polls state). | Unchanged; proven stable below. |

Proof: each file 20× in a row while 32 CPU busy loops ran (`node -e 'for(;;){}'` ×32 on 8 cores, plus other
agents' work; load average 45–95):

| File | Passed |
| --- | --- |
| `worker-gateway.test.ts` | 20/20 |
| `worker-replay.test.ts` | 20/20 |
| `worker-identity.test.ts` | 20/20 |
| `audit.test.ts` | 20/20 |
| `notifications.test.ts` | 20/20 |

Web jsdom: one failure in a full web-project run at load ≈ 50 (`directory.test.tsx` "owner creates a user through
step-up…", a `findBy*` wait). The file then passed 3/3 on its own. No root cause found; web code unchanged
(another agent owns those screens).

## 7. Security review

The suite adds no production surface. The three fixes narrow behaviour: F1 makes the worker refuse work it
cannot prove safe (fail closed — the master's reconciliation decides), F2 only reorders messages the worker
already sends, F3 swallows a connection error event that every subsequent query still reports. The process
worker fixture is test-only and accepts the fake runtime only because the worker config's own guard does not
apply to it (it never reads a config file); it is not shipped (`test/` is not in the build). Throw-away
containers bind loopback only and use random passwords passed via `docker run -e`.

## 8. Rollback

Revert the commits; no migrations, no protocol change. Without F1/F2/F3 the scenarios 1c, 2b and 6b fail.

## 9. UNVERIFIED / not covered

- GitHub provider: "no duplicate PR" is covered only through the plain-git provider (no PRs); the GitHub
  `ensurePullRequest` idempotency stays covered by its unit tests (p4-git-flow §11 UNVERIFIED-LIVE).
- Multi-replica masters (two live masters on one database) are not exercised: running-jobs reports and the
  worker hub are per process (p4-orchestration §12, p7-ha).
- A second crash of the same worker before the replayed ASSIGN_JOB is processed loses F1's in-memory
  "already ran" marker; the master's lease expiry still reconciles the attempt, but a rerun is possible in that
  double-fault case (would need a persisted tombstone).
- Real runtimes, Linux/Windows/Pi workers and sandboxed execution are out of scope (fake runtime, macOS host).
