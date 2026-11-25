# p10-backup-restore — compose backup service, encrypted off-site copies and a weekly restore drill

Status: implemented (2026-10-18), not yet deployed. Owner approval: "backups and a restore drill".
Builds on [p1-backups](p1-backups.md) (age encryption to the owner's keys, read-only `remyral_backup` role,
host systemd timer + Garage on the same host) and replaces its host timer once verified on the host
(§9). Runbook: [docs/ops/backup-restore.md](../ops/backup-restore.md). Owner note (Turkish):
[docs/guide/tr/yedekleme.md](../guide/tr/yedekleme.md). Migration **0075** (notification kinds). No ADR: no
architectural boundary moves (Postgres stays the durability boundary, ADR-0003; secrets handling ADR-0006).

## 1. What changes compared with p1-backups

| p1-backups (running today) | p10-backup-restore |
|---|---|
| Host systemd timer + scripts in `/opt/remyral-src`, packages on the host (`age`, AWS CLI) | A `backup` service **in the compose project** (`remyral-<env>`), image built by the deploy like master/web — nothing installed on the host outside `/data/remana/<env>` and the project |
| Encrypted dumps only in Garage **on the same host** | Local copies under `/data/remyral/<env>/backups` **plus** an optional off-site S3-compatible target (AWS S3 or Cloudflare R2) with credentials the owner provides |
| No automatic restore test | **Weekly restore drill** into a throw-away Postgres, integrity checks, measured restore time |
| Status only in journald | Status in the console (Settings → Backups) and notifications `backup.failed` / `restore_drill.failed` |
| 15-min dumps, 14 d frequent + 400 d daily | Configurable schedule (default **nightly 02:30 UTC**; `BACKUP_INTERVAL_MINUTES` for more frequent runs), retention **7 daily / 4 weekly / 3 monthly** |

The owner's existing age keys (`<operator-key-dir>`, p1 §2) are reused: the same `recipients.txt` goes to
`/data/remana/<env>/backup-config/recipients.txt`.

## 2. Components

```
remyral-<env> (compose project)
  postgres ──(remyral_backup, read-only, TCP on "internal")──▶ backup  (image remyral-backup:<tag>)
                                                              │  node runner (infra/backup/runner, no npm deps)
                                                              │  pg_dump / pg_restore / initdb / postgres 18.6 (same image as the server)
                                                              │  age (owner's public keys only)
       /data/remana/<env>/backups  ◀──── rw ───────────────────┤
       /data/remana/<env>/stack.env, secrets/, backup-config/ ◀ ro
       off-site S3/R2 (optional) ◀──── HTTPS SigV4 ────────────┘
  master ◀── ro bind of /data/remana/<env>/backups/status ── status.json → Settings → Backups, notifications
```

- **Image** `infra/backup/Dockerfile`: `FROM postgres:18.6-alpine@sha256:…` — the very image of the
  production server, so `pg_dump`/`pg_restore` match the server exactly and the drill's throw-away server is
  the same build — plus Alpine `nodejs` (24.x) and `age` (1.3.x), the runner and the master's migration files
  (for the drill's migration check). Built on the host by `deploy.mjs`, recorded and signed in the release
  record like master/web.
- **Service** `backup` (compose profile `backup`, so `compose up` without naming it — Coolify, `pnpm
  e2e:compose` — does not start it; the deploy names it). Long-running `remyral-backup daemon`: schedules
  backups and drills, heartbeats into `status.json`. Manual: `docker compose … exec -T backup remyral-backup
  run|drill|status`.
- **Drill project** `infra/backup/drill.compose.yaml` (project `remyral-<env>-drill`, `network_mode: none`,
  no ports): the same image running one drill on demand, for the runbook and for a drill on another host.
- **Master** `apps/master/src/backups/`: reads and validates `status.json` (Zod), `GET /v1/backups/status`
  (action `backups.read`, owners/admins), orchestrator step that raises notifications.
- **Console** Settings → Workspace → **Backups** (admins): status only, no download (§6).

## 3. Backup run

1. Lock (`/backups/.lock`, exclusive create; a stale lock of a dead pid is taken over). One run or drill at
   a time per environment (daemon, `exec` and the drill project share it).
2. **Consistent snapshot.** A `psql` session as `remyral_backup` opens `BEGIN ISOLATION LEVEL REPEATABLE READ
   READ ONLY`, exports its snapshot (`pg_export_snapshot()`), and in that snapshot reads: server version,
   `schema_migrations` (head + count), the audit head (`id`, `hash`), exact row counts of **every** base table
   in `public`, and fingerprints of a few known entities (newest row by `id` of `users`, `projects`, `workers`,
   `jobs`, `audit_events`, `chat_threads`, `output_items`: `id` + `md5(row::text)` with fixed `DateStyle`,
   `TimeZone`, `extra_float_digits`, `bytea_output`). `pg_dump --snapshot=<id> --format=custom
   --compress=zstd` then dumps exactly that snapshot — the manifest's counts describe the dump byte for byte.
3. **Files** (`/data/remyral/<env>/backups`, root, 0700/0600):
   `db/remyral-<env>-<UTC stamp>.dump`, `db/remyral-<env>-<stamp>.manifest.json`,
   `secrets/remyral-<env>-<stamp>.secrets.tar.age`.
4. **Secrets archive**: `tar` of `stack.env`, `secrets/` and `backup-config/` (incl. the off-site
   credentials), streamed straight into `age -R recipients.txt` — the plaintext never touches disk. Plaintext
   and ciphertext SHA-256 go into the manifest.
5. **Manifest** (plaintext, no secret): format `remana-backup-manifest/v1`, id, env, times, versions,
   schema head, audit head, table counts, fingerprints, file sizes + SHA-256, tier, recipients (public keys),
   and after the upload the off-site keys and ciphertext hashes.
6. **Off-site** (only when `backup-config/offsite.env` exists): the dump is age-encrypted to a temporary file,
   hashed, uploaded; then the secrets archive; the manifest last (a manifest off-site means its objects are
   complete). Every PUT/part carries `x-amz-content-sha256` (signed, verified by the server) and
   `Content-MD5`; the full-object SHA-256 is stored as `x-amz-meta-sha256` and checked with a `HEAD` after
   the upload. Objects > 256 MiB use multipart (32 MiB parts, aborted on failure). The runner never deletes
   off-site objects: expiry is the bucket's lifecycle (names below), so a token without delete rights works.
7. **Retention** (local, §4), then `status.json`.

Outcome: `ok`; `partial` (local backup good but the secrets archive or the off-site copy failed / is not
configured — still restorable from this host); `failed` (no usable local backup; files of the attempt removed).

### Naming (lifecycle-friendly)

Off-site key: `<prefix>/<tier>/<env>/<YYYY>/<MM>/<DD>/remyral-<env>-<stamp>.{db.dump.age,secrets.tar.age,manifest.json}`
with `tier` = `monthly` (first successful backup of the UTC month), `weekly` (first of the ISO week), `daily`
(first of the UTC day) or `frequent` (further runs that day). Suggested lifecycle rules: `frequent/` 2 days,
`daily/` 8 days, `weekly/` 36 days, `monthly/` 100 days (≈ 7 / 4 / 3 like local). Default prefix `remyral`.

## 4. Retention (pure, `retention.mjs`)

Kept: the newest successful backup of each of the newest **7 UTC days**, **4 ISO weeks** and **3 months**
that have backups, plus everything younger than `BACKUP_KEEP_RECENT_HOURS` (default 0; useful with frequent
runs), plus always the newest successful backup. Everything else of **this environment** (`remyral-<env>-…`;
files of another environment are never touched) is deleted. Drill reports are kept 26 weeks.

## 5. Restore drill (weekly, default Sunday 04:00 UTC; also `remyral-backup drill`)

1. Latest local backup with a manifest (or `--backup <id>`). Dump size and SHA-256 must match the manifest.
2. Free-space check (≥ 4 × dump + 512 MiB in `/backups`); otherwise the drill fails with that reason.
3. Throw-away server **inside the backup container**: `initdb` into `/backups/.drill/<id>` (owned by
   `postgres`), started with `listen_addresses=''` (Unix socket in a 0700 directory only — no TCP, no port),
   `fsync=off` (disposable). No Docker socket is ever given to any container (§7), so the scheduled drill does
   not start a sibling container; the on-demand drill project (§2) is the separate-compose-project variant.
4. Roles `remyral_owner`, `remyral_app`, `remyral_backup` created `NOLOGIN`, database `remyral` owned by
   `remyral_owner`, `pg_restore --exit-on-error` from the dump (timed: **restore time**).
5. Checks (all must pass): migration check (every applied `schema_migrations` row exists in this release's
   migration files with the same checksum; head equals the manifest; files not yet applied are reported as
   pending, not a failure), exact row counts = manifest, fingerprints = manifest, full audit-chain verification
   (same algorithm as `verifyChain`, canonical JSON + SHA-256) and the chain head = manifest audit head,
   restored database size.
6. Server stopped (`immediate`), scratch directory removed — always, also on failure.
7. Report `drills/remyral-<env>-<stamp>.drill.json` + `status.json`: backup id, pass/fail, per-check result,
   restore/total time, dump and restored size.

## 6. Console and alerts

- **Settings → Backups** (owners/admins): health (ok / warning / failing / not configured) with reasons,
  last backup (time, size, duration, tier, outcome, schema, off-site status), last successful backup, next
  scheduled run, local usage and free disk, retained count, last drill (pass/fail, restore time, sizes, checks),
  next drill. **No download** of dumps or archives through the console: a DB dump is the whole database
  (sessions, sealed credentials, audit) — exfiltration through one stolen admin session must not be one
  click; the runbook is the only restore path.
- **Notifications** (owners and admins, in-app + opted-in channels): `backup.failed` — a run failed or was
  partial (off-site/secrets), no successful backup for longer than the expected interval × 1.5 + 1 h, or the
  backup service stopped heartbeating for 30 min; `restore_drill.failed` — a drill failed or no successful
  drill for 8 days + 1 h. Dedupe keys use the run id (one notification per event), the last success id
  (one per staleness episode) or the last heartbeat (one per outage). Migration 0075 adds both kinds to the
  CHECK constraints of `notifications` and `notification_preferences` with **every** existing kind.

## 7. Security review

- **No decryption key next to the backups.** The host holds only `age1…` public keys; the runner refuses a
  recipients file containing `AGE-SECRET-KEY-` and refuses to run when any file in `secrets/` or
  `backup-config/` contains an age identity. Off-site copies and the secrets archive are therefore readable
  only with the owner's offline identity (primary or break-glass). A stolen bucket token reveals ciphertext.
- **Local DB dumps are not encrypted** (deliberate): they live on the same disk, with the same trust
  boundary, as the live `pgdata` volume and the secrets dir (root-only, 0700/0600); encrypting them to the
  owner's key would make the automatic drill impossible, and a key the host can use would protect nothing
  against host root. Everything that leaves the host is encrypted.
- **Least privilege.** DB access as `remyral_backup` (`pg_read_all_data`, read-only default, owns nothing).
  Container: read-only root fs, `no-new-privileges`, `cap_drop: ALL` + `CHOWN`, `SETUID`, `SETGID` (drill
  server runs as `postgres`) and `DAC_READ_SEARCH` (read the secrets files owned by uid 10001). Not on the
  proxy network, no published port, no Docker socket. The drill server listens on no TCP port. Sources are
  mounted read-only; only `/data/remyral/<env>/backups` is writable. The master gets only the `status/`
  sub-directory, read-only.
- **Credentials.** Off-site credentials only in `backup-config/offsite.env` (0600, owner-provided, never in
  the repo, never logged — errors are reduced to the HTTP status and S3 error code). The runner refuses
  `http://` endpoints except loopback (tests).
- **Integrity.** SHA-256 of every file in the manifest; the drill re-hashes the dump; off-site uploads are
  signed over their payload hash and verified by HEAD; age is authenticated encryption; the audit chain head
  ties a restored database to the time of the backup.
- **Status file is untrusted input for the master**: size-capped (256 KiB), Zod-validated, strings
  truncated, and notifications use fixed texts plus ids/numbers (no free text from the file).
- **Plaintext manifest off-site** holds row counts (business metadata) and SHA-256 fingerprints of one row per
  known table. A fingerprint only confirms a guessed full row; the fingerprinted `users` row includes the scrypt
  hash and sealed TOTP secret (high entropy), so it cannot be brute-forced. No secret value is in the manifest.
- **`BACKUP_S3_ALLOW_HTTP=test-only`** exists for the e2e's fake S3; whoever can set it can already read the
  off-site credentials, and the objects are age-encrypted anyway. Production endpoints are `https://`.
- **Environment isolation.** Paths default from `REMYRAL_ENV`; the runner only touches `remyral-<env>-*` files.
- **Redis** is not backed up: it holds BullMQ dispatch hints and rate-limit counters only (ADR-0003); the
  relay re-publishes pending outbox rows, the reconciliation loop rebuilds leases from Postgres. Restoring an
  old Redis next to a restored database would replay stale hints — after a restore Redis starts empty.

## 8. RPO / RTO

- **RPO**: default nightly → up to 24 h (+ dump time). `BACKUP_INTERVAL_MINUTES=60` → 1 h. The SLO's 15 min
  ([slo.md](../ops/slo.md)) is met only while the p1 15-minute host timer keeps running or with
  `BACKUP_INTERVAL_MINUTES=15` (fine while a dump takes seconds). Owner decision; the canvas note asks.
- **RTO**: restore onto a fresh host ≤ 2 h (runbook §4); the drill measures the restore step every week
  (seconds today).

## 9. Rollout and rollback

Deploy: build + sign the backup image, start `backup` with the release, pre-deploy backup through the
service when it runs (else the p1 systemd unit, as before). Owner: copy `recipients.txt` (public keys) to the
host — Claude does it from `<operator-key-dir>/recipients.txt`; optional off-site credentials. After one
week of green runs and drills, retire the p1 timer + Garage (or keep the 15-min timer for the SLO).
Rollback: `docker compose -p remyral-<env> stop backup` (nothing depends on it); the migration only widens
CHECK constraints.

## 10. Tests

Unit (`scripts/test/backup-*.test.mjs`): schedule, naming/tiers, retention, manifest validation, SigV4 against
the AWS documentation example, recipients checks, status reduction. Master: status parsing, health and
notification rules (unit), API + notifications (integration). Web: Settings → Backups. Integration
(`apps/master/test/integration/backup-roundtrip.test.ts`): real `pg_dump` with exported snapshot → manifest →
`pg_restore` into a second temporary database on the dev Postgres → counts, fingerprints, migration check and
audit chain verified; tampering detected. E2E (`pnpm e2e:backup-drill`): builds the image, runs the service
against a throw-away Postgres project, backup + drill inside the container, encrypted secrets archive, retention.
