# ADR-0004: Job leases, fencing epochs and idempotency

- **Status:** Accepted — owner-delegated sign-off, 2026-10-13 — §2 amended by
  [ADR-0039](0039-master-outage-grace-and-standby.md) (2026-10-19: an offline grace while the master is unreachable; the
  master holds such a lease for grace + one lifetime before LOST; a refused renewal fences at once)
- **Date:** 2026-10-12
- **Related:** p4-leases, p4-recovery, A-ORCH-3, A-FLEET-5, AGENTS.md rule 6

## Context
Workers are on residential networks and will disconnect. AGENTS.md requires durable leased jobs, at-least-once delivery and fencing/idempotency so retries never duplicate side effects (commits, pushes, PRs).

## Decision
1. **Lease:** assigning an attempt creates a `Leases` row `{jobId, attemptId, workerId, epoch, expiresAt}`. `epoch` is a per-job monotonically increasing integer (fencing token). The worker receives a lease token signed by the master (Ed25519, short TTL) containing these fields.
2. **Renewal:** worker renews via `LEASE_ACK`/`RENEW_LEASE` before expiry. A lease that expires moves the job to reconciliation (`LOST` pending decision), never straight to re-run.
3. **Fencing at every side-effect boundary:** every worker → master write (events, results, artifact refs) carries `epoch`; the master rejects stale epochs. Side effects outside the master (git push, PR creation) go through master-mediated operations or include the epoch in an idempotency key (e.g. branch `rac/<jobId>/<attempt>` and a commit trailer `Remyral-Attempt: <attemptId>/<epoch>`), so a stale attempt cannot overwrite a newer one (push with lease: `--force-with-lease` never used without an expected ref).
4. **Idempotency keys:** every message has `messageId`; master stores processed ids per worker with a bounded window; replays are acknowledged without re-processing.
5. **Retry policy:** only steps declared idempotent are auto-retried. Non-idempotent steps after a lost lease require reconciliation (inspect remote branch state) or human approval.

## Alternatives considered
- Exactly-once via distributed transactions — impossible across git remotes/LLM providers.
- Redis-based locks (Redlock) — not safe for fencing; rejected.

## Consequences
Branch/PR naming and git flow (p4-git-flow) must embed attempt identity. Workers must persist current lease state locally to survive daemon restarts.

## Verification
p4-chaos test matrix: worker crash mid-push, network partition after push before ack, duplicate ASSIGN_JOB, two workers holding stale/current epochs — no silent duplicate commits.
