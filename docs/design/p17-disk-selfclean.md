# p17-disk-selfclean — the worker frees its own disk space

Status: implemented (branch `p17-disk-selfclean`). Owner item: the internal note `bilinen-eksikler` (not published) "Disk" — the Linux worker
`ip-10-0-0-12` had 0.5 GB free under a 2 GB minimum, so machine tasks waited with `disk_low`
(apps/worker/src/jobs/runner.ts `DISK_LOW` decline; the master's placement filter; apps/web/src/lib/reasons.ts already
says why a job waits). Missing was the worker cleaning what it owns.

## 1. Rules

The worker deletes **only what it created itself and can recreate**, oldest first, until the free space under its
workspace root reaches the target. It never deletes:

- user data outside its data dir and workspace root (it never walks anything else);
- Docker / Podman images (the owner's; the worker's code-node images are rebuilt only on request);
- the git mirrors (`<workspaceRoot>/mirrors/*.git`) — **decision**: they are shared by every worktree of a repository,
  also by retained and parked attempts and by service hand-offs; deleting one breaks those worktrees and costs a full
  clone on the next job. They are not cache in that sense. When they are what fills the disk, the usage report (§4)
  says so and the owner decides;
- the directories of a running or admitted job, a parked attempt (`.remyral/parked/<jobId>.json`, approval pause /
  usage-limit park), a recoverable one (`.remyral/continuity/<jobId>.json`, session continuity) or a service (`svc-*`);
- a kept working directory before its retention ended or while it is pinned (a deploy / service / follow-up needs it);
- the active managed runtime version, or any version of a runtime that has a running job or an install in progress;
- a package cache an attempt holds;
- a staged release while an update is in flight or while an activation request names it;
- the install dir's `versions/` (current + previous for rollback): it is root / admin owned and read-only for the
  service account; the privileged updater prunes it itself (keeps current + previous + one).

## 2. Categories (apps/worker/src/disk/sources.ts)

Each source lists candidates (size, age, `light` or not). `light` = always safe to drop; the others only while space is
low. Order of a low-disk run: `temp` → `logs` → `releases` → `workspaces` → `runtimes` → `packageCaches`, oldest first
within a category.

| Category | What | light |
|---|---|---|
| `temp` | `<workspaceRoot>/sandboxes/<jobId>/` leftovers of finished jobs (nothing changed for 1 h; never protected jobs, `svc-*`, dot entries); `<dataDir>/caches/.trash/*`; `<dataDir>/runtime-verify/<runtime>/*` older than 6 h | yes |
| `logs` | rotated generations only (`*.log.N`, `*.log.N.gz`, `*.log.old`, shawl `*_r<date>.log`) in `<dataDir>/logs` and, on Windows, the service wrapper's `logs` dir; never the live file. Also the pre-rename service's leftovers in those dirs (`remana-worker_rCURRENT.log`, `remana-worker_r<date>.log`: a Remyral worker never writes them; exact prefix only, p17-cutover-cleanup) | beyond 64 MiB of rotated logs or older than 30 days; the rest only while low; pre-rename leftovers always |
| `releases` | `<dataDir>/updates/staged/<version>/` | yes |
| `workspaces` | kept directories of workspace jobs whose retention and pin ended (the hourly sweep waits a day of grace for the master; a low disk does not — the master is told `expired`); failed / cancelled worktrees kept for inspection (`workspace.retainFailed`), removed through the workspace manager (git worktree prune) | no |
| `runtimes` | inactive managed versions `<dataDir>/runtimes/<runtime>/<version>/` (reinstallable from the pinned set) | older ones yes; the newest inactive (quick rollback) only while low |
| `packageCaches` | the shared package caches, least recently used project first (`PackageCaches.candidates` / `evictForSpace`) | no |

## 3. When it runs (apps/worker/src/disk/hygiene.ts)

- **Check** every 5 minutes (first after 1 minute): free bytes under the workspace root (the file system jobs need).
  Below `workspace.minFreeBytes + margin` a `low_disk` run starts — at most one per 30 minutes.
- **Daily** light run: 10 minutes after the start (or 24 h after the last one, kept across restarts), then every 24 h;
  only `light` candidates.
- **Manual** ("Şimdi temizle", OPS_COMMAND `disk.clean`): like a low-disk run, at once. It also works when the automatic
  cleanup is switched off (an explicit admin request).

A run removes every `light` candidate, then the others while free < target, measuring the free space after each removal.
Free space not measurable → only `light` candidates (never empties the caches blindly). One run at a time; a request
while one runs joins it. A failed removal is counted (`errors`) and logged, never retried in the same run. The last run
and the times of the last daily / low-disk run are kept in `<dataDir>/disk-hygiene.json` (0600, atomic).

## 4. Reporting

- **CAPABILITIES `diskHygiene`** (`DiskHygieneReport`, packages/protocol/src/disk-hygiene.ts): enabled, threshold,
  margin, target, free bytes and when measured, running, the last run (trigger, free before / after, bytes and items
  freed per category, still low, errors), the earliest next low-disk run and the next daily run. Re-sent after every
  run. Stored in `workers.disk_hygiene` (migration 0158) and shown on the machine page (Genel bakış → Kapasite → Disk
  temizliği) through `GET /fleet/overview` (`diskHygiene: { supported, report }`).
- **Still low after a run**: `usage` — sizes of the top-level entries of the data dir and of the workspace root. Only
  names the worker creates (`DISK_USAGE_NAMES`: runtimes, caches, tools, mcp, logs, updates, …, jobs, kept, mirrors,
  sandboxes, .remyral); the entry of the data dir that holds the workspace root is `workspace-root`; everything else
  (any other directory, any file, links — never followed) is summed into `other`. No file name ever leaves the machine.
  The schema itself refuses other names.
- **Doctor**: the master check `workers.disk` says `disk_low_after_cleanup` (freed MiB, the largest directory) when a
  worker below its minimum already cleaned and stayed low; the plain `disk_low` fix names "Disk temizliği → Şimdi
  temizle". The machine doctor (`remyral-worker doctor`) adds `disk:last_cleanup` (info) next to a low-disk finding.
- **Worker log**: every removal (`disk hygiene removed`, category, worker-owned path / ids, bytes) and the summary.

## 5. "Şimdi temizle"

`POST /workers/:id/disk/clean` (authz `workers.ops.write` = machine admin, step-up, CSRF, rate-limited like every
remote op) → signed OPS_COMMAND `{kind: "disk.clean"}` (no parameter: what may be deleted is fixed by the worker) →
OPS_UPDATE `diskClean` (the run). Audited `worker.ops.disk.clean` (request) and `worker.ops.result` (outcome). The
master writes the run into the stored report at once (`jsonb_set … lastRun`), so the machine page shows it before the
next CAPABILITIES. Worker side: remote-ops group `install` (a local `remoteOps.disabled: [install]` refuses it — it
removes what the worker installed and cached).

## 6. Configuration

Panel machine configuration (existing generation mechanism): `workspace.diskHygiene = { enabled, marginBytes? }`
(protocol `DiskHygieneSettings`, margin ≤ 1 TiB). Absent: on, margin 1 GiB (`DEFAULT_DISK_HYGIENE_MARGIN_BYTES`).
Makine → Yapılandırma → Çalışma alanı: "Disk temizliği" (makine varsayılanı (açık) / açık / kapalı) and "Temizlik payı
(GiB)". The threshold is `workspace.minFreeBytes` in effect ("En az boş disk").

## 7. Protocol and compatibility

Feature `disk-hygiene-v1` (additive in protocol 1.0). The master sends `disk.clean` and `workspace.diskHygiene` to no
worker without it (`worker_update_required`, reason `disk_hygiene`; a config issue at `workspace.diskHygiene` — an older
worker would strip the key and fail the document hash). An older master ignores `diskHygiene` in CAPABILITIES (zod
strips it) but **refuses the unknown feature name** in CAPABILITIES (`WorkerFeature` is a closed enum), like every
earlier feature: **the master must be deployed before the worker release that advertises `disk-hygiene-v1`.**

## 8. Rollback

Worker: an older build has no hygiene (the state file is ignored). Master: migration 0158 is additive (two nullable
columns, one more op kind); an older master ignores them. Delete with
`DELETE FROM worker_ops WHERE kind = 'disk.clean'; ALTER TABLE workers DROP COLUMN disk_hygiene, DROP COLUMN disk_hygiene_at;`.

## 9. Tests

- worker `test/disk-hygiene.test.ts`: an in-memory file system with Linux, macOS and Windows path shapes — every source
  (protected jobs, young dirs, services, parked / continuity records, rotated log names, pending activation, pinned /
  unexpired / active kept dirs, active / busy runtimes), the engine (daily light only, order and target, still low →
  usage without user names, unmeasurable free space, failed removals, spacing, off, joining runs, state across restarts),
  the usage report with the workspace root inside the data dir, the real-fs port and the state file.
- worker `package-caches.test.ts` (candidates / evictForSpace never take a held cache), `remote-ops-agent.test.ts`
  (disk.clean, unsupported, local opt-out), `managed-config.test.ts`, `doctor.test.ts`, `workspace-scratch.test.ts`
  (removeRetained).
- protocol `test/disk-hygiene.test.ts` (report, run, closed names, CAPABILITIES, op, config, feature).
- master integration `remote-ops.test.ts` (feature gate, viewer 403, step-up, signed command without parameters, result,
  stored last run, both audit rows, fleet overview), `doctor.test.ts` (`disk_low_after_cleanup`), `worker-config.test.ts`
  (config key refused for an older worker).
- web `test/disk-hygiene.test.tsx` (panel, usage, viewer, step-up + operation, older worker / master) and
  `diyalog-w3-machine-config.test.tsx` (the config switch and margin).

Not verified on a real machine: Windows shawl rotated-log names (the pattern follows flexi_logger's `_r<timestamp>`
naming), the 5-minute check on a real low disk, and the cleanup of `ip-10-0-0-12` itself.
