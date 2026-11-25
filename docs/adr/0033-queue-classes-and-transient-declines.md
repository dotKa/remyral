# ADR-0033: Queue classes, an urgent slot reserve and transient (busy) worker declines

- **Status:** Accepted — owner decisions 2026-10-17 (the internal note `kuyruk-plani` (not published) §4)
- **Date:** 2026-10-17
- **Deciders:** owner; implemented by `p9-queue-priority`
- **Related:** docs/design/p9-queue-priority.md (design + security review), ADR-0004 (leases), ADR-0007 (sandbox
  profiles, T-SBX-4), ADR-0011 (protocol versioning), p4-quotas (fair share), p8-capacity-auto (effective slots)

## Context
A worker's refusal of an assignment was always treated as permanent for that job: placement excluded the worker
(`declined_before`) and, with one capable machine, failed the job within seconds. In production (2026-10-17) the only
Windows worker refused a second host-restricted job because host attempts without filesystem confinement must run alone
(T-SBX-4) — a busy state, not an impossibility. The master also did not know per-profile limits and had no way to let
urgent work through a fleet busy with long jobs.

## Decision
1. **Decline kinds.** `LEASE_ACK` carries `declineKind: transient | permanent` and `retryAfterMs?` (additive, protocol
   1.0). Transient declines keep the job queued and make it wait for that worker until the worker runs fewer jobs than
   when it declined or the retry time passes; only permanent declines exclude the worker for the job. Older workers are
   classified by their known busy texts; everything else stays permanent.
2. **Per-profile slots** (`profile-slots-v1`). Workers report `profileConcurrency` and `exclusiveProfiles` — a generic
   per-profile ceiling any build may report from its isolation. The master places against its own per-profile lease
   count; a full profile is a transient wait. The worker's own profile selection stays the enforcement point.
3. **Classes.** Acil · Normal · Arka plan are bands of the numeric priority (+50 / 0 / −50; urgent ≥ 50, background
   ≤ −50). Dispatch tries classes in order (urgent, normal, background); aging and weighted fair share apply inside a
   class; aging never changes a job's class.
4. **Urgent reserve.** Each machine keeps `urgent_reserve` (0/1/2, default 1) of its effective slots for urgent jobs when
   it has at least two; normal and background jobs see the rest (always at least one).
5. **Queue adjustments** (reorder, run now) live in `job_queue_priority`, never in the `jobs` row; reorder stays within
   the job's class (operator+ in the project); run now makes a job urgent (admin, step-up). All audited.
6. **Chat urgency.** A drafted job is Normal unless the user's own message in that turn asks for urgency; the master
   enforces this independently of the model's prompt.

## Alternatives considered
- **Retry a declined job on the same worker on a fixed timer** — hot loops of decline round-trips and audit rows; the
  lease-count rule asks again exactly when room appears.
- **Preemption (pause / cancel a running job for an urgent one)** — runtimes have no safe pause; cancel-and-restart
  loses work. Rejected by the owner (S1 → 5a).
- **A separate short-job lane** — needs reliable duration estimates first; the job_stats medians are used for display
  only.
- **A `queue_rank` column for drag and drop** — would compete with aging and fair share and need its own semantics;
  priority adjustments within the class keep one ordering rule.
- **Storing the class as its own column** — two sources of truth with the numeric priority; the band keeps one.

## Consequences
- Jobs no longer fail because a machine is busy; a misbehaving worker can at most delay a job it is the only candidate
  for (as it could by declining before).
- A 2-slot machine runs at most one normal job at a time by default; admins can set the reserve to 0 per machine.
- Background jobs can wait indefinitely on a busy fleet (by design); the long-wait notification tells their creator.
- Worker release needed for structured decline kinds and per-profile slots; the master works with older workers.

## Verification
Scheduler unit tests (decline kinds, per-profile slots, reservation, class tiers with aging and fair share), protocol
tests (fields, legacy classification of the production text), worker tests (profile slots, decline kinds), master
integration with real worker daemons reproducing the production case (the second host job waits and runs, never
FAILED), RBAC matrix / route coverage for the queue routes, web tests for the queue screen and class pickers.
