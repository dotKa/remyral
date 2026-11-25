# Service Level Objectives

- **Status:** Draft for P0 sign-off
- **Date:** 2026-10-12
- **Scope:** single-region control plane (one host, e.g. an EC2 instance under Coolify) and a small fleet of outbound-connected workers. Targets are deliberately realistic for a single-instance control plane; raising them requires an HA ADR.

## SLIs and objectives

| # | SLI | Objective (28-day window) | Measurement |
|---|---|---|---|
| SLO-1 | Control-plane availability: share of 1-min probes where `/healthz` (API + DB + Redis) and dashboard login page succeed | **99.5 %** (≈3.4 h/month budget) | External uptime probe (outside AWS) + internal health metrics |
| SLO-2 | Worker reconnect latency: time from network restoration to `online` state | **p95 ≤ 30 s**, p99 ≤ 120 s | Worker-reported disconnect/reconnect timestamps |
| SLO-3 | Job start latency: `QUEUED` → `RUNNING` when an eligible idle worker exists | **p95 ≤ 20 s** (excluding clone time), p95 ≤ 90 s including clone of a ≤500 MB repo | Job state transition timestamps |
| SLO-4 | Event delivery latency: worker event emitted → visible in dashboard | **p95 ≤ 2 s** while connected | End-to-end synthetic job |
| SLO-5 | Job state correctness: jobs ending in a state contradicting reality (e.g. SUCCEEDED without result, duplicate commit) | **0** (any occurrence is an incident) | Reconciliation audit job |
| SLO-6 | Cancellation latency: cancel requested → runtime stopped | **p95 ≤ 10 s** for runtimes with supported cancel; `degraded` cancel ≤ 30 s | Adapter events |

## Recovery objectives

Updated 2026-10-19 for p11-master-resilience (ADR-0039, owner decision 2026-10-18: outage target 15 min, a standby).

| Objective | Target | Notes |
|---|---|---|
| RPO (Postgres) | **≤ 5 min** with WAL archiving + off-site (`PG_WAL_ARCHIVE=on`, `offsite.env`); otherwise the dump interval (nightly ≤ 24 h, `BACKUP_INTERVAL_MINUTES=15` → ≤ 15 min) | `archive_timeout` 180 s + shipping every ~30 s, age-encrypted, create-only (docs/ops/backup-restore.md §10); Redis is not a durability boundary (ADR-0003) |
| RTO — master process restart, deploy, host reboot | **≤ 5 min** to serving again; **no running job is lost** if the control plane is back within 15 min (below) | Docker restart policy; workers reconnect with backoff ≤ 60 s |
| RTO — control plane lost, standby restore to a fresh EC2 | **≤ 1 h** (scripted: `scripts/ops/standby-restore.mjs` fetch → restore → verify → cutover) | Unchanged worst case ≤ 2 h for the manual dump runbook (backup-restore.md §5); proven by p7-dr-drill / p11-master-standby-live with a timed run |
| Worker rebuild | ≤ 30 min per node | Installer + re-pair |

### Job survival through a control-plane outage (ADR-0039)

Applies to workers with `offline-grace-v1` (worker release of p11) and `LEASE_OFFLINE_GRACE_MS` = 900 000 (default).

| Outage (master down, host reboot, network loss worker ↔ master) | Running jobs |
|---|---|
| ≤ **15 min** (guaranteed: lease 90 s + grace 15 min − renewal interval 30 s − reconnect backoff ≤ 60 s) | keep running; results, events, logs and approval requests are buffered in the worker's fsynced outbox and applied on reconnect; at most one run per attempt |
| 15 – ~16.5 min | survive if the worker reconnects before `last acknowledged renewal + 90 s + 15 min` (typical) |
| longer | the worker stops the attempt itself (self-fence); the master marks the lease LOST at `last renewal + 90 s + 15 min + 90 s` and reconciles: retry when verifiably side-effect free, else "needs human review" |
| master reachable but refusing the renewal | the worker stops at once |
| master reachable, renewals not confirmed (e.g. its database stuck) | classic rule: 3 min after the session started |
| worker daemon restarted during the outage | that attempt is lost (as before); the master notices as soon as the worker reports without it |

During an outage nobody can cancel a job or decide its approvals; the runtime's own approval timeout still applies.
Without the worker release (older workers) the classic ~3 min applies.

## Error budget policy

- Budget burn > 50 % in a window: freeze non-security feature deploys to production until the cause is fixed.
- Any SLO-5 violation: incident, postmortem, regression test before next release.

## Alerting (feeds p6-alerts)

- SLO-1 fast burn (2 % budget in 1 h) → page; slow burn (10 % in 24 h) → ticket.
- Worker offline > 10 min while it had leased work → page.
- Queue backlog: eligible jobs waiting > 5 min → notify.
- Failure spike: job failure rate > 3× 7-day baseline over 30 min → notify.
- Budget: 80 % of any project/provider budget → notify; 100 % → stop new jobs (policy).
