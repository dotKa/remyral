# ADR-0003: Postgres is source of truth, BullMQ is delivery

- **Status:** Accepted — owner-delegated sign-off, 2026-10-13
- **Date:** 2026-10-12
- **Related:** p4-job-store, p4-dispatch, A-ORCH-6

## Context
ROADMAP fixes Postgres as the source of truth for jobs/state and Redis/BullMQ as the delivery mechanism, and requires the queue to survive master and Redis restarts with Postgres state reconciling.

## Decision
1. Every job state transition is written in a Postgres transaction together with an `outbox` row (transactional outbox). Nothing is enqueued in BullMQ directly from request handlers.
2. A dispatcher relays outbox rows to BullMQ. BullMQ messages carry only `jobId` + `attemptId` + `fencingEpoch`; consumers re-read Postgres and treat the message as a hint.
3. A reconciliation loop periodically compares Postgres (`QUEUED`/`RESERVED`/`RUNNING` with expired leases) to BullMQ and worker reports, and repairs drift. Redis loss is therefore recoverable from Postgres alone.
4. State transitions are validated against an explicit transition table in `packages/scheduler`; illegal transitions are rejected and audited.

## Alternatives considered
- Postgres-only queue (SKIP LOCKED / pg-boss) — simpler, but contradicts the fixed architecture; kept as fallback if BullMQ adds no value in practice (would need a superseding ADR).
- BullMQ as source of truth — rejected: Redis persistence is not our durability boundary.

## Consequences
Every delivery is at-least-once; consumers must be idempotent (see ADR-0004).

## Verification
p4-chaos: kill Redis mid-flight and flush it; all jobs reach a correct state after reconciliation, no duplicate side effects.
