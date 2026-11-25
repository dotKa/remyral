# ADR-0039: Jobs survive a 15-minute master outage (offline lease grace); a WAL-based standby for the single-host control plane

- **Status:** Accepted — owner decision, 2026-10-18: "Kesinti hedefi 15 dakika olsun. Yedek mekanizmamız olsun."
- **Date:** 2026-10-19
- **Deciders:** owner (targets), agent (design)
- **Related:** p11-master-resilience, p11-master-standby-live, ADR-0003, ADR-0004 (amended), ADR-0005, ADR-0011,
  p10-backup-restore, p7-dr-drill, docs/design/p11-master-resilience.md, docs/ops/slo.md

## Context

One EC2 host runs the whole control plane (docs/ops/slo.md); the owner runs one worker machine for now. A running job
survived about 3 minutes without its master (lease 90 s, self-fence after ttl + ttl, LOST at expiry), so a deploy, a
reboot or a few minutes of residential network loss killed every running job. Losing the host meant RTO ≈ 2 h and RPO up
to 24 h. The owner set a 15-minute outage target and asked for a backup mechanism for the control plane. ADR-0004's
guarantee — never two live runs of one attempt, never a blind rerun after possible side effects — must hold.

## Decision

1. **Offline lease grace (amends ADR-0004 §2).** The master grants `offline-grace-v1` workers an offline grace
   (`LEASE_OFFLINE_GRACE_MS`, default 15 min, 0 = off) with every lease, stored per lease (migration 0087, immutable)
   and sent as `lease.offlineGraceMs`. The master **holds** such a lease for grace + one lease lifetime past its expiry:
   it stays live for every fencing check, keeps its slot and is not marked LOST — also across master restarts, because
   the bound is stored with the lease. It ends the hold early only when the worker is connected, has reported, and does
   not run the attempt.
2. **"Renewal confirmed" is separated from "master reachable".** Every LEASE_ACK carries a worker-chosen messageId; the
   master answers with `RENEW_LEASE.ackId`. The worker dates its offline grace by the **send time** of the acknowledged
   LEASE_ACK (never by the renewal's arrival), keeps running while no session to the master is up until
   `ackSentAt + ttl + grace`, uses the classic rule (`ttl + selfFenceGrace` since the later of the last confirmation and
   the session start) while connected, and **fences at once** when the master refuses one of its renewal requests.
   While offline it queues no renewal requests; after every reconnect it sends one at once, behind the replayed outbox.
3. **Buffering:** results, events, logs and approval requests produced during the outage stay in the fsynced outbox and
   are applied as live on reconnect (the lease is held). A full outbox back-pressures the runtime instead of failing the
   run; the replay is paced at ≤ 150 messages/s.
4. **Restored master, newer workers:** a master whose database is older than what a worker saw (standby restore)
   catches up both sequence cursors at session start instead of wedging the session (master renumbers its pending
   outbox after the worker's cursor; the worker renumbers its pending outbox after the master's).
5. **Standby for one host + object storage (default).** Opt-in continuous WAL archiving (`PG_WAL_ARCHIVE=on`:
   `archive_mode`, `archive_timeout` 180 s) into a `walarchive` volume; the existing backup service ships each segment
   age-encrypted to the owner's off-site bucket (S3 / R2, create-only) within ~30 s and takes a daily physical base
   backup (`pg_backup_start` / `pg_backup_stop`; manifest with LSNs, schema version and the lease-signing key id). RPO
   ≤ 5 min. `scripts/ops/standby-restore.mjs` fetches + decrypts (owner key only, never stored on the server), restores
   base + WAL to the newest (or a chosen) point on a fresh host, verifies schema, row counts, secrets and the lease key
   id, and moves the console DNS record (Cloudflare API, or the documented manual step); workers reconnect to the same
   hostname by themselves. The weekly restore drill also replays WAL onto the local base to a recent point. Settings →
   Backups shows standby readiness (last WAL shipped, lag, last base backup, last standby drill). No streaming replica
   by default (one host; a second always-on host is a later decision).
6. **Targets** (docs/ops/slo.md): job survival through a master/network outage ≤ 15 min (guaranteed by the timing
   math, ≈ 16 min typical); control-plane RPO ≤ 5 min with WAL archiving + off-site (≤ 24 h / ≤ 15 min without);
   RTO for a process/host restart ≈ minutes, for a lost host by standby restore ≤ 1 h.

## Alternatives considered

- **Just raise the lease TTL to 15 min.** Rejected: a dead or partitioned-but-running worker would then also hold its
  slot and block reconciliation for 15 min while *reachable*, and a refusal could not stop it sooner; the grace only
  applies while the master is unreachable and refusals still fence at once.
- **Measure the grace from the renewal's arrival.** Rejected: a renewal delivered late (replayed after a reconnect)
  would stretch the worker's deadline past the master's hold — a real split-brain window. Dating by the acknowledgement's
  send time removes message delay from the safety argument.
- **Put the grace into the signed lease token.** Rejected: the claims are a strict v1 schema; every older worker would
  reject the token. The field travels in the authenticated session like the rest of the payload; the master's stored
  hold, not the worker's claim, is what protects the invariant.
- **Second always-on host with streaming replication as the default.** Rejected for now: doubles cost and operations for
  one worker and one owner; WAL shipping to object storage reaches RPO ≤ 5 min with the existing backup service.
  Can be added as an optional profile later without changing this ADR's lease rules.
- **Frequent pg_dump (every 5 min) instead of WAL.** Rejected: full logical dumps of a database that holds artifacts are
  large; WAL ships only changes and allows point-in-time recovery.

## Consequences

- Workers need the new release (`offline-grace-v1`); until then their leases stay classic. Master deploy with migration
  0087. `LEASE_OFFLINE_GRACE_MS` in the master environment (compose default 900000).
- Cancel, approval decisions and policy switches cannot reach a job while the master is down; a job may run up to
  16.5 min without supervision (sandbox and secret rules are local and unchanged).
- A job lost after a longer outage is reconciled exactly as before (retry only when verifiably safe).
- Standby needs owner steps: an off-site bucket + credentials (existing `offsite.env`), `PG_WAL_ARCHIVE=on` and the
  backup grants (infra/backup/sql/backup-role.sql) applied once, a `deploy.mjs --infra`; a standby drill on a fresh host.
- The messages inside the RPO window are lost on a standby restore; the reconciler treats the affected jobs as lost
  leases.

## Verification

- Worker unit tests (lease-watch, runner offline grace, store renumbering), master integration tests (grant, hold, early
  end, outbox catch-up), chaos `outage.chaos.ts`: master down 10 min (survives, one run, one commit), 20 min (fence,
  LOST, safe retry), worker offline across a master restart, restore from a standby snapshot then reconnect; negative
  control without the grace fails.
- Standby: runner unit tests, the WAL / base backup / replay round trip against a real `postgres:18.6-alpine`
  (docs/ops/backup-restore.md §9–§11, `pnpm e2e:backup-standby`), the weekly drill's WAL replay check.
- Live (UNVERIFIED until done, `p11-master-standby-live`): a 15-minute master outage on production with the Windows
  worker; a standby restore onto a fresh EC2 host with the DNS cutover.
