# p11-master-resilience — a master outage of up to 15 minutes, and a standby for the control plane

- **Status:** Implemented (2026-10-19)
- **Backlog:** `p11-master-resilience` (live verification: `p11-master-standby-live`)
- **Decision record:** [ADR-0039](../adr/0039-master-outage-grace-and-standby.md)
- **Owner decision (2026-10-18):** one worker machine for now; "Kesinti hedefi 15 dakika olsun. Yedek mekanizmamız olsun."
- **Related:** ADR-0004 (leases, fencing), ADR-0005 (worker transport), [p2-transport.md](p2-transport.md),
  [p4-orchestration.md](p4-orchestration.md), [p4-chaos.md](p4-chaos.md),
  [p10-backup-restore.md](p10-backup-restore.md), [docs/ops/slo.md](../ops/slo.md),
  [docs/ops/backup-restore.md](../ops/backup-restore.md), owner summary [docs/guide/tr/kesinti-yedek.md](../guide/tr/kesinti-yedek.md)

## 1. Problem

The control plane is one EC2 host (docs/ops/slo.md). Until now a running job survived about **three minutes** without
its master: the lease lives 90 s (`LEASE_TTL_MS`), the worker renews every 30 s and **self-fences** — stops the attempt
and reports nothing — when no renewal was confirmed for `ttl + one ttl` (`apps/worker/src/jobs/runner.ts`, ADR-0004
§2). The master marks such a lease LOST at expiry and decides retry / fail after a 180 s reconnect grace
(`orchestrator.ts`, `reconcileLost`). A master deploy that takes a few minutes, a host reboot, or the home uplink of
the worker flapping for five minutes therefore killed every running job — the owner wants 15 minutes.

Second, losing the host meant an RTO of about 2 h and an RPO of up to 24 h (nightly dump; off-site optional and not
configured). The owner wants a backup mechanism that brings the control plane back, with the same workers, quickly.

## 2. What survives now (summary)

| Event | Before | Now |
|---|---|---|
| Master process down / restart / deploy, host reboot, network loss between worker and master | jobs killed after ~3 min | jobs keep running for **15 min** (guaranteed; ≈ 16 min typical); results, events, logs, approval requests wait in the worker's fsynced outbox and are replayed |
| Longer outage (> 16.5 min) | — | the worker fences itself; the master marks the lease LOST only after it holds no longer (~18 min) and reconciles: retry when verifiably safe, else "needs human review" (unchanged ADR-0004 §5 rules) |
| Master reachable but **refuses** the renewal | worker ran on until its timer | worker fences **at once** |
| Master reachable, renewals neither confirmed nor refused | 3 min | 3 min from the session start (classic rule) |
| Worker daemon restarted mid-outage | job lost, master LOST after expiry | same loss (no process behind it), the master ends the hold as soon as the worker reports without the attempt |
| Host lost | RTO ≈ 2 h, RPO ≤ 24 h | standby restore from base backup + WAL: RPO ≤ 5 min, RTO ≈ 30–45 min scripted (§7) |

## 3. Design: separate "renewal confirmed" from "master reachable"

### 3.1 The grant

The master grants an **offline grace** `G` (`LEASE_OFFLINE_GRACE_MS`, default 900 000 = 15 min, 0 disables) with every
lease it gives to a worker that advertises the feature **`offline-grace-v1`**. It is stored on the lease row
(migration 0087: `leases.offline_grace_ms`, `leases.offline_hold_ms`, both immutable once issued) and sent as
`ASSIGN_JOB` / `RENEW_LEASE` `lease.offlineGraceMs`. Older workers ignore the field and older masters never send it:
a lease without a grant is the classic lease, byte for byte.

The master **holds** a granted lease for `offline_hold_ms = G + leaseTtl` past `expires_at`. "Held" means: it is live
for every fencing check (`LEASE_HELD_UNTIL_SQL`: job store transitions and renewals, inbox routing, credential and input
requests, machine-admin, sub-jobs, previews, approval-mode switch), it keeps its slot, and the sweep does not move the
job to LOST. Because the bound is stored per lease and judged against the stored `expires_at`, a master that restarts
in the middle of an outage judges every lease the same way the old process would have: it waits for the worker to come
back within the hold, independent of how long the master itself was down.

### 3.2 The worker's fence deadline (`apps/worker/src/jobs/lease-watch.ts`)

Times are monotonic (`performance.now()`), never wall clock. Per attempt the runner keeps:

- `confirmedAt` — when the lease was last confirmed (assignment, any renewal);
- `ackConfirmedAt` — the **send time** of the LEASE_ACK that the newest renewal answered. Every LEASE_ACK now carries a
  worker-chosen `messageId`; the master echoes it as `RENEW_LEASE.ackId`. The master renewed no earlier than that
  acknowledgement left the worker, so `ackConfirmedAt ≤ master renewal time`, however late the renewal arrived.

```
classic  = confirmedAt + ttl + selfFenceGrace                        (selfFenceGrace defaults to ttl)
offline  = max(classic, ackConfirmedAt + ttl + G)                    (only with a grant and an ack-correlated renewal)
deadline = classic                                                    without grant / before the first ack-correlated renewal
         = offline                                                    while no session to the master is up
         = min(offline, max(confirmedAt, sessionStart) + ttl + selfFenceGrace)   while connected
```

A watch timer (every ¼ renewal interval, ≤ 1 s) requests renewals only while a session is up (a fresh one immediately
after every reconnect, queued behind the replayed outbox) and stops the attempt — silently, as before — once the
deadline passed. An `ERROR stale_epoch` that answers one of the attempt's own renewal requests (matched by `inReplyTo`)
fences a granted attempt **at once**: a master that is reachable and refuses the lease is not an outage. (A classic
lease keeps the old behaviour: only logged, because the reconciler may still resume it under a new epoch.)

### 3.3 The master's sweep

`sweepExpiredLeases` now returns leases past `expires_at` with their `heldUntil`. A held lease is expired early only
when its worker is connected, has reported in this session and does **not** list the attempt in its HEARTBEAT
(`lease_expired` with `endHold`; recovery note "ended in its offline hold"). Otherwise it is left alone until
`heldUntil`. The store refuses `lease_expired` of a held lease without `endHold` (`lease_held`). After LOST, the
existing reconciliation runs unchanged (reconnect grace, resume when the worker reports the attempt, retry only when
verifiably side-effect free, else needs human review; a durable CANCEL_JOB for the abandoned attempt).

### 3.4 Buffering during the outage

Everything the attempt produces is already sequenced into the worker's fsynced outbox (ADR-0011) and replayed in order
after the next `SESSION_ESTABLISHED`; the master applies it as live because the lease is held:
- results (`JOB_RESULT`), events, logs, artifacts — including a job that **finished** during the outage;
- **approval requests**: the `approval_request` event reaches the master after the reconnect and creates the approval
  then; the runtime waits for the decision with its usual timeout (worker default 15 min, or the master's
  approval-pause timing on `approval-pause-v1` workers — p10-approval-pause);
- renewal requests are *not* queued while offline (they would be stale); one fresh request follows the replay.

New: when the outbox is full (10 000 entries / 8 MiB), runtime output waits for room (the adapter's event stream is
back-pressured) instead of failing the run; the outbox replay is paced at ≤ 150 messages/s so a long backlog never
trips the master's 200/s per-connection limit (which closes the socket and would restart the replay).

The git credential of a repository job is fetched once at the start of the run (valid 1 h), so a push at the end of a
run during an outage works without the master; the master verifies the pushed branch after the reconnect as usual.

## 4. Why split-brain stays impossible

The invariant (ADR-0004): the master never runs the same job's attempt elsewhere while the old attempt may still run.

1. **Worker bound ≤ master bound.** The worker's offline deadline is `A + ttl + G` with `A` the send time of an
   acknowledgement the master answered. The master renewed at `P ≥ A` to `expires_at = P + ttl` and holds until
   `P + ttl + G + ttl`. So the master holds at least one full lease lifetime longer than any worker deadline — margin
   for clock-rate drift and scheduling, not for message delay (the ack correlation removed the delay term).
2. **Late renewals cannot stretch the grace.** A RENEW_LEASE delivered late (e.g. replayed after a reconnect) dates
   the grace by its *acknowledgement's* send time. A renewal that answers no known acknowledgement (older master,
   reconciliation resume) restarts only the classic rule. The classic rule's existing safety argument is unchanged:
   the master waits `expiry + reconnect grace` before any reassignment, and every abandoned attempt gets a durable
   CANCEL_JOB that follows any stale renewal in the same ordered stream.
3. **Refusal fences.** If the master has moved on (lease LOST or superseded), the next renewal request of a connected
   worker is refused and the worker stops immediately.
4. **After LOST, retries stay gated** (ADR-0004 §5): a run that may have pushed is never rerun blindly.
5. **Fencing of writes is unchanged.** Every message carries attempt + epoch; stale ones are journaled and refused.

What we accept: during a master outage nobody can cancel the job or answer its approvals; a job that should have been
cancelled runs up to 16.5 min longer (its result is then refused or reconciled as cancelled). A worker whose clock runs
much faster than the master's (> 9 %) could fence a little early — the safe direction.

## 5. Restore from a backup: cursors that went back in time

A standby restore brings back a database that is **older** than what the workers saw (the RPO window). Two cursors
would otherwise wedge every session (found while building the restore scenario):
- master → worker: the worker already processed master seqs the restored database never issued; it would ignore new
  messages as duplicates and its ACK would be a protocol violation. **Master:** at session start, if the worker's
  `HELLO.resumeFromSeq ≥ next_master_seq`, the pending `worker_outbox` rows are renumbered to follow the worker's
  cursor and numbering continues after them (`WorkerReplay`, logged "numbering caught up").
- worker → master: the restored master's `last_worker_seq` is behind messages the worker already dropped as
  acknowledged; the first replayed message would look like a gap forever. **Worker:** when the master's resume cursor
  is below the first pending seq − 1, the pending entries are renumbered to follow it (cursor persisted first, so a
  crash in between never drops an entry) — `WorkerStore.resumeOutbound`, logged.
The messages inside the RPO window are lost with the old host (events, logs, a result reported in that window: the
reconciler handles that job like any lost lease). Worker identities (public keys), lease-signing keys and TOTP keys
come back with the database and the encrypted secrets archive, so workers reconnect with challenge-response as before
and keep trusting the lease keys they pinned.

## 6. Tests

- `apps/worker/test/lease-watch.test.ts` — the deadline rules (classic, grant without correlation, offline dating by
  the ack's send time, reconnect, never stricter than classic).
- `apps/worker/test/job-runner.test.ts` › "offline grace" — runs past the classic deadline while offline and fences at
  ttl + grace; a fresh renewal request at reconnect; a refusal fences at once; renewals without `ackId` start no
  grace; a classic lease is not fenced by a refusal.
- `apps/worker/test/store.test.ts` › p11 — renumbering after a rolled-back master (and across a restart).
- `apps/master/test/integration/lease-offline-grace.test.ts` — the grant only for `offline-grace-v1`, the hold and its
  end, the early end when the worker comes back without the attempt.
- `apps/master/test/integration/worker-replay.test.ts` › p11 — master outbox numbering catch-up.
- `apps/master/test/chaos/outage.chaos.ts` (`pnpm chaos`), production timings, the master's fake clock as the workers'
  lease clock, a cuttable TCP hop for network loss:
  1. master down 10 min → the job survives, renews, completes once (no `lease_expired`, epoch 1, one commit);
  2. master down 20 min → the worker fences, the master marks LOST and retries safely (no commit of the fenced attempt);
  3. worker offline while the master restarts (9 min) → still RUNNING, renewed when the network is back, completes;
  4. restore from the standby (pg_dump snapshot, traffic after it lost) → master on the restored database, same port and
     signing key → the worker reconnects (both cursor catch-ups), the job completes, all chaos invariants hold on the
     restored database.
  Negative control: with `offlineGraceMs: 0` scenarios 1 and 3 fail (the job dies).
- Standby / WAL: see [p10-backup-restore.md](p10-backup-restore.md) and docs/ops/backup-restore.md §9 (tests listed there; `scripts/test/backup-standby.test.mjs`, `pnpm e2e:backup-standby`).

## 7. Standby for one host + object storage

See ADR-0039 §2 and docs/ops/backup-restore.md (§10 WAL archiving, §11 standby restore runbook). Summary: Postgres
`archive_mode` (opt-in, `PG_WAL_ARCHIVE=on`) writes WAL segments into the `walarchive` volume; the backup service ships each
segment age-encrypted to the off-site bucket within seconds and makes a daily physical base backup (low-level
`pg_backup_start` / `pg_backup_stop`), so RPO ≤ 5 min (`archive_timeout` 180 s + ship interval). The weekly drill also
replays WAL onto the local base to a recent point. `scripts/ops/standby-restore.mjs` fetches + decrypts (owner key, on
the owner's machine or a tmpfs on the new host), restores base + WAL to the newest point, verifies schema, row
counts, signing keys (lease key id = the base manifest's) and health, and moves the console DNS record (Cloudflare API)
— workers reconnect on their own within their 60 s backoff to the same hostname.

## 8. Security review

- **Trust:** the grant is decided by the master from its own configuration and the worker's advertised feature; the
  hold is computed and stored by the master. A worker cannot extend its own grace (the master never reads a grace from
  a worker). `offlineGraceMs` / `ackId` are not part of the signed lease token (adding a claim would break every older
  worker's strict token check); they travel inside the authenticated, TLS-protected session like every other field.
  A compromised master is out of scope (it can already assign anything).
- **Worker-chosen messageIds** (LEASE_ACK): validated as UUIDs on both sides; a reused id with another seq is the
  existing protocol violation (the session closes) — a worker can only hurt itself.
- **Longer unsupervised runs:** an attempt may now run 15 min without any master. During that time cancel, approval
  decisions and policy switches cannot reach it; sandbox, egress and secret boundaries are enforced locally and are
  unchanged. Approval-gated actions still wait for a human (the request reaches the master after the reconnect).
- **Audit:** every state transition still happens on the master: `lease_expired` (with "ended in its offline hold" when
  cut short), retries and failures carry reasons; refusals of stale messages are audited as before (`job.message`
  denied, `stale_epoch`). The cursor catch-up after a restore is logged at warn level on both sides.
- **Restore safety:** renumbering redelivers master messages that the restored database still considered pending
  (at-least-once; every job message is fenced by attempt + epoch on the worker); nothing is ever dropped silently on the
  worker (cursor before renumbering).
- **Rollback:** `LEASE_OFFLINE_GRACE_MS=0` turns grants off for new leases at once (existing leases keep the hold they
  were granted). The worker feature is additive; an older worker or master is the classic behaviour. Migration 0087
  is additive (two columns with default 0 and the guard trigger including them).

## 9. Unverified

- A real 15-minute master outage on production with the Windows worker (desktop-pc) — `p11-master-standby-live`.
- A real standby restore onto a fresh EC2 host from real S3/R2 objects, and the Cloudflare DNS cutover — same task.
