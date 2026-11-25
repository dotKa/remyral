# Backups, restore drill and disaster recovery

Covers `p10-backup-restore` (design and security review: [docs/design/p10-backup-restore.md](../design/p10-backup-restore.md))
and the warm standby of `p11-master-resilience` (§10–§11; design: [docs/design/p11-master-resilience.md](../design/p11-master-resilience.md),
ADR-0039).
It supersedes the host systemd timer of [backups.md](backups.md) (p1) once the compose service has run green on
the host for a week (§8). User guide in Turkish: [docs/guide/tr/yedekleme.md](../guide/tr/yedekleme.md).

| Piece | Where |
|---|---|
| Backup service | compose service `backup` in project `remyral-<env>` (profile `backup`, started by the deploy) |
| Image | `remyral-backup:<tag>` from `infra/backup/Dockerfile` (postgres 18.6-alpine of the server + node + age), built and signed by `scripts/deploy/deploy.mjs` |
| Runner | `infra/backup/runner/` (`remyral-backup daemon|run|drill|status|list|check|verify-file`) |
| Local backups | `/data/remyral/<env>/backups/` (root, 0700): `db/`, `secrets/`, `drills/`, `status/` |
| Owner public keys | `/data/remyral/<env>/backup-config/recipients.txt` (age `age1…` lines only) |
| Off-site credentials (optional) | `/data/remyral/<env>/backup-config/offsite.env` (0600, owner-provided) |
| On-demand drill project | `infra/backup/drill.compose.yaml` (project `remyral-<env>-drill`, `network_mode: none`) |
| Console | Settings → Backups (owners/admins; status only, no download), incl. **Standby readiness** |
| WAL archive (optional, `PG_WAL_ARCHIVE=on`) | compose volume `walarchive` (postgres writes, the backup service ships and removes) → `backups/wal/*.gz` (local copies) and off-site `<prefix>/wal/<env>/` |
| Base backups (with WAL archiving) | `backups/base/<id>.base.tar.gz` + `.base.json` (newest only) → off-site `<prefix>/base/<env>/` |
| Standby restore | `scripts/ops/standby-restore.mjs` (`fetch`, `restore`, `verify`, `cutover`), §11 |
| Alerts | notifications `backup.failed`, `restore_drill.failed` (owners and admins) |

## 1. What is backed up

| What | How | Encrypted? |
|---|---|---|
| Postgres `remyral` (all state: jobs, artifacts in `job_artifacts`, outputs, chat attachments, credentials sealed with the master keys, the hash-chained audit log) | `pg_dump --format=custom --compress=zstd --snapshot=<exported>` as the read-only `remyral_backup` role; the manifest's row counts, entity fingerprints and audit head are read in the **same snapshot** | Locally: no (same disk and trust boundary as `pgdata`, see design §7). Off-site: **yes**, age to the owner's keys |
| Recovery secrets: `stack.env`, `secrets/` (TOTP key, lease signing key, `vapid.pem`, SMTP/webhook/GitHub/OIDC/skills keys, …), `backup-config/` (recipients, off-site credentials) | `tar` streamed into `age -r <owner keys>` — plaintext never on disk | **Always** (local and off-site) |
| p17-object-storage: the master's **local blob directory** (compose volume `blobdata`, mounted read-only as `/blobs`): job outputs and inputs, site uploads, worker releases and installer kits when no object storage is configured (and those stored before a bucket was chosen) | mirrored incrementally after every backup run: each new blob `age`-encrypted into `backups/blobs/data/<key>.age` (index `backups/blobs/index.json`) and, with an off-site target, uploaded to `<prefix>/blobs/<env>/<key>.age`; a blob the master deleted stays `BACKUP_BLOB_KEEP_DELETED_DAYS` (default 35) — §12 | **Always** (local and off-site) |
| p17-object-storage: blobs in an **S3-compatible bucket** (Settings → Integrations → Storage) | **Not copied by the runner**: the bucket is their system of record. Turn on bucket versioning, expire non-current versions after 35 days, abort incomplete multipart uploads after 1 day (optionally Object Lock / R2 bucket lock). The dump holds their rows, keys and hashes and the sealed bucket keys | provider-side (SSE) |
| Redis | **Not backed up.** It holds BullMQ dispatch hints and rate-limit counters only (ADR-0003): pending work is re-published from the Postgres outbox, leases are reconciled from Postgres. After a restore, Redis starts empty — that is correct; an old Redis next to a restored DB would replay stale hints. | — |
| Deploy state / release records (`/data/remyral/<env>/deploy/`) | Not backed up: re-created by the next deploy (an empty state is a first deploy) | — |
| Coolify itself, worker machines | Not covered (re-install: `infra/ec2/bootstrap.sh`; workers keep their own identity and re-connect) | — |

The host never holds a key that can decrypt anything: the runner refuses a recipients file with a private key
and refuses to run when any file in `secrets/` or `backup-config/` contains an age identity.

**Schedule.** Default nightly at **02:30 UTC** (`BACKUP_TIME`), or every `BACKUP_INTERVAL_MINUTES` (15…10080) if set
in `stack.env`. After downtime over the slot, the daemon catches up (runs now, at most one retry per hour while
failing). Restore drill weekly, default **Sunday 04:00 UTC** (`BACKUP_DRILL_WEEKDAY`, `BACKUP_DRILL_TIME`,
`BACKUP_DRILL_ENABLED=false` to switch off), and once right after the first backup.

**Retention (local).** Newest successful backup per day for 7 days, per ISO week for 4 weeks, per month for 3
months (`BACKUP_KEEP_DAILY|WEEKLY|MONTHLY`, `BACKUP_KEEP_RECENT_HOURS` to keep all recent ones with frequent runs);
the newest backup is never removed; files of other environments are never touched. Drill reports: 26 weeks.

**Off-site naming** (lifecycle rules match the tier prefix):
`<prefix>/<tier>/<env>/<YYYY>/<MM>/<DD>/remyral-<env>-<UTC stamp>.{db.dump.age,secrets.tar.age,manifest.json}`,
tier = `monthly` (first backup of the month) | `weekly` (first of the ISO week) | `daily` | `frequent`. The runner
never deletes off-site objects.

## 2. RPO / RTO

| | Target | How it is met |
|---|---|---|
| **RPO** with WAL archiving (`PG_WAL_ARCHIVE=on` + off-site copy, §10) | **≤ 5 min** | A segment is closed at the latest every 180 s (`archive_timeout`) while anything is written; the backup service ships it within 30 s (plus the upload). Lag over 10 min warns in Settings → Backups, over 30 min notifies, over 60 min fails |
| **RPO** without WAL archiving | default **≤ 24 h** (nightly); **≤ 1 h** with `BACKUP_INTERVAL_MINUTES=60`; ≤ 15 min with `BACKUP_INTERVAL_MINUTES=15` | Logical dumps are consistent snapshots; off-site RPO equals the local one while uploads succeed (a failed upload alerts) |
| **RTO** standby restore to a fresh host (§11) | target **≤ 1 h** (UNVERIFIED on a real EC2: provisioning ~20 min, fetch + replay minutes, deploy ~15 min, DNS seconds when proxied) | `standby-restore.mjs` does fetch → restore → verify → cutover; the e2e (`pnpm e2e:backup-standby`) runs the whole path locally in about a minute |
| **RTO** logical restore to a fresh host (§5) | **≤ 2 h** | The weekly drill measures the pure restore time (seconds today); the rest is provisioning and DNS. Record the measured times of a real run in §5.9 (p7-dr-drill, A-SEC-5) |
| **RTO** in place on a healthy host (§4) | **≤ 30 min** | |

## 3. Operations

All commands on the host as root, `E=prod`, `P=remyral-$E`, `C="docker compose -p $P --project-directory /opt/remyral-src-<tag> --env-file /data/remyral/$E/stack.env --env-file /data/remyral/$E/deploy/release.env -f /opt/remyral-src-<tag>/infra/coolify/compose.yaml"`
(`<tag>` = current release, `node scripts/deploy/deploy.mjs status`). Simpler for read-only commands:
`B=$(docker ps -qf label=com.docker.compose.project=$P -f label=com.docker.compose.service=backup)`.

```sh
docker exec $B remyral-backup status          # status.json + heartbeat
docker exec $B remyral-backup list            # local backups (tier, schema, sizes, off-site yes/no)
docker exec $B remyral-backup check           # recipients, off-site config, DB reachable as read-only remyral_backup
docker exec $B remyral-backup run --reason manual    # backup now (exit 0 = ok/partial, 1 = failed)
docker exec $B remyral-backup drill                  # restore drill now on the newest backup
docker logs --since 24h $B                   # daemon log (no secrets are logged)
```

On-demand drill as its own compose project (another container, no network at all):

```sh
docker compose -p $P-drill --env-file /data/remyral/$E/stack.env --env-file /data/remyral/$E/deploy/release.env \
  -f /opt/remyral-src-<tag>/infra/backup/drill.compose.yaml run --rm drill [--backup remyral-$E-<stamp>]
```

The deploy runs a blocking backup in the service before every migration (`deploy.mjs`, step "pre-deploy backup in
the backup service"); a failed backup stops the deploy.

### 3.1 Set up (first deploy with the backup service)

1. Owner keys exist (p1: `<operator-key-dir>/identity.txt` + `break-glass.txt` on the owner's side). Copy only the
   public file: `scp <operator-key-dir>/recipients.txt <host>:/tmp/` then on the host
   `install -d -m 0700 /data/remyral/$E/backup-config && install -m 0644 /tmp/recipients.txt /data/remyral/$E/backup-config/recipients.txt && rm /tmp/recipients.txt`.
2. `REMYRAL_DB_BACKUP_PASSWORD` is in `stack.env` and the role can log in (p1 §3 did this on prod).
3. `install -d -m 0700 /data/remyral/$E/backups` (otherwise Docker creates it at the first start).
4. Deploy (`node scripts/deploy/deploy.mjs`): builds `remyral-backup:<tag>`, starts `backup` after master/web.
5. `docker exec $B remyral-backup check` → `"problems": []`. The daemon makes the first backup and the first drill
   within minutes; Settings → Backups shows both.

### 3.2 Off-site copy (optional, owner provides credentials)

`/data/remyral/$E/backup-config/offsite.env`, mode 0600 (it is itself inside the encrypted secrets archive):

```sh
# AWS S3
BACKUP_S3_BUCKET=remyral-backups-<account>-<region>
BACKUP_S3_REGION=eu-central-1
BACKUP_S3_ACCESS_KEY_ID=AKIA…
BACKUP_S3_SECRET_ACCESS_KEY=…
# BACKUP_S3_PREFIX=remyral            (default)

# Cloudflare R2 (instead of the AWS lines)
BACKUP_S3_BUCKET=remyral-backups
BACKUP_S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com
BACKUP_S3_ACCESS_KEY_ID=…
BACKUP_S3_SECRET_ACCESS_KEY=…
```

Least privilege: **AWS** — an IAM user (or role) with `s3:PutObject` and `s3:GetObject` on
`arn:aws:s3:::<bucket>/remyral/*` only (GetObject covers the HEAD verification; no `DeleteObject`, no `ListBucket`
needed for uploads). **R2** — an API token "Object Read & Write" scoped to this one bucket. Bucket: versioning
on, public access off. Lifecycle rules (both providers): expire `remyral/frequent/` after 2 days, `remyral/daily/`
after 8, `remyral/weekly/` after 36, `remyral/monthly/` after 100 (AWS: `aws s3api put-bucket-lifecycle-configuration`;
R2: dashboard → bucket → Settings → Object lifecycle rules). Object Lock (AWS, governance mode) is optional extra
protection against a stolen token deleting backups.

Takes effect at the next run (`docker exec $B remyral-backup run`); the result shows `offsite.status: uploaded`.
Uploads sign the payload hash (`x-amz-content-sha256`) and send `Content-MD5`; the full-object SHA-256 is stored as
`x-amz-meta-sha256` and re-read with `HEAD`.

## 4. Restore on the same host (logical corruption, bad migration, accidental deletion)

**remyral-ctl hosts (p17-host-actions):** Ayarlar → Yedekler → Yedekleri yönet → a backup → "Geri yükle" (owner; the
backup id typed again, a fresh authenticator code), or `sudo remyral-ctl restore --backup <id> --yes` — stop master +
backup, restore into `remyral_restore`, rename (the replaced database stays as `remyral_replaced_<stamp>`), migrate
forward with the running release, start, health gate. Settings, recipients, the off-site target, "backup now" and the
drill are in the same screen (design: docs/design/p17-host-actions.md §5). Coolify / EC2 (no host applier): the steps
below.

Needs a human decision (destructive). Uses the **local** plaintext dump — no owner key required.

```sh
docker exec $B remyral-backup list                       # pick an id, e.g. remana-prod-20261018T023000Z
ID=remana-prod-20261018T023000Z
docker exec $B remyral-backup drill --backup $ID         # proves this backup restores and passes all checks
PG=$(docker ps -qf label=com.docker.compose.project=$P -f label=com.docker.compose.service=postgres)
$C stop master backup                                   # nothing writes during the swap
docker cp /data/remyral/$E/backups/db/$ID.dump $PG:/tmp/restore.dump
docker exec -u postgres $PG psql -U postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE remyral_restore OWNER remyral_owner'
docker exec -u postgres $PG pg_restore -U postgres -d remyral_restore --exit-on-error /tmp/restore.dump
docker exec -u postgres $PG psql -U postgres -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'remyral' AND pid <> pg_backend_pid();
ALTER DATABASE remyral RENAME TO remyral_broken;
ALTER DATABASE remyral_restore RENAME TO remyral;
REVOKE ALL ON DATABASE remyral FROM PUBLIC;
GRANT CONNECT ON DATABASE remyral TO remyral_app, remyral_backup;
SQL
docker exec $PG rm -f /tmp/restore.dump
$C up -d --no-deps master backup                        # migrate is a no-op unless the dump is older than the schema
```

Then: smoke test (deploy-coolify.md §6), Audit → Verify chain in the console, keep `remyral_broken` until the
owner agrees to `DROP DATABASE remyral_broken`. Redis: `docker exec <redis> redis-cli -a … FLUSHDB` is **not** needed
(stale hints for missing jobs are ignored), but restarting master clears in-process state. A dump older than the
current release's schema is migrated forward by `migrate` (`$C run --rm migrate`) before master starts.

## 5. Disaster recovery onto a fresh host (runbook; time every step)

With WAL archiving on (§10), prefer the **standby restore** of §11: it loses at most minutes instead of the time since
the last dump and scripts §5.2–§5.7 and the DNS step. This section stays the fallback (no WAL off-site, or a base /
WAL chain that does not verify).

Assumes the old host and its disk are gone, and the off-site copy exists. Two people roles: **owner** (holds the age
identity, decrypts on their own machine) and **operator** (Claude or the owner, on the new host). Never copy the
identity to the server; if it must be used there, use a tmpfs file and `shred -u` it right after.

### 5.1 New host

1. Launch a host like the old one ([deploy-coolify.md §10](deploy-coolify.md#10-host-perimeter-and-access); encrypted disk), run
   `infra/ec2/bootstrap.sh`, install Coolify's proxy (Traefik) so the external Docker network `coolify` exists.
2. SSH alias for the deploy (`<host>` → new IP) and the deploy signing key as before (cicd.md).

### 5.2 Fetch the newest backup (owner's machine)

```sh
# AWS (use a principal that may read the bucket)
aws s3 ls s3://<bucket>/remyral/ --recursive | sort | tail -6            # newest manifest/db/secrets of one stamp
aws s3 cp s3://<bucket>/remyral/daily/prod/2026/10/18/remana-prod-20261018T023000Z.manifest.json .
aws s3 cp s3://<bucket>/remyral/daily/prod/2026/10/18/remana-prod-20261018T023000Z.db.dump.age .
aws s3 cp s3://<bucket>/remyral/daily/prod/2026/10/18/remana-prod-20261018T023000Z.secrets.tar.age .
# R2: the same with  --endpoint-url https://<account id>.r2.cloudflarestorage.com  and R2 credentials,
#     or download the three objects in the Cloudflare dashboard.
```

Pick the newest stamp whose **manifest** exists (the manifest is uploaded last: present ⇒ complete). Check the
ciphertext hashes before decrypting:

```sh
jq -r '.offsite.db.sha256, .files.secrets.sha256' remana-prod-*.manifest.json
shasum -a 256 remana-prod-*.db.dump.age remana-prod-*.secrets.tar.age      # must match the two lines above
```

### 5.3 Decrypt (owner's machine, with the identity)

```sh
age -d -i <operator-key-dir>/identity.txt -o db.dump      remana-prod-<stamp>.db.dump.age
age -d -i <operator-key-dir>/identity.txt -o secrets.tar  remana-prod-<stamp>.secrets.tar.age
shasum -a 256 db.dump secrets.tar   # = manifest .files.db.sha256 and .files.secrets.plaintextSha256
```

(break-glass identity: `-i break-glass.txt` — either one decrypts everything.) `age` refuses a modified or
truncated file. Transfer `db.dump`, `secrets.tar` and the manifest to the new host over SSH (`scp` to `/root/dr/`,
mode 0600); delete the plaintext copies on the owner's machine afterwards.

### 5.4 Restore the secrets (new host, root)

```sh
install -d -m 0700 /data/remyral/prod
tar -x -p --same-owner --numeric-owner -f /root/dr/secrets.tar -C /data/remyral/prod      # stack.env, secrets/, backup-config/
ls -ln /data/remyral/prod/secrets      # owner uid 10001, mode 0400 as before
```

### 5.5 Source tree of the matching release

The manifest's `schema.version` (e.g. `0075`) names the schema; use the release that was running (deploy log /
`git log -- apps/master/migrations` for the newest commit whose newest migration equals it, or newer). A newer
release migrates the restored schema forward; an older one refuses to start. Export it like the deploy does
(`git archive <commit> | ssh <host> 'mkdir -p /opt/remyral-src && tar -x -C /opt/remyral-src'`).

### 5.6 Postgres only, then restore

```sh
cd /opt/remyral-src
docker compose -p remyral-prod --env-file /data/remyral/prod/stack.env -f infra/coolify/compose.yaml up -d --wait postgres
# the initdb hook creates remyral_owner / remyral_app / remyral_backup with the RESTORED passwords
PG=$(docker ps -qf label=com.docker.compose.project=remyral-prod -f label=com.docker.compose.service=postgres)
docker cp /root/dr/db.dump $PG:/tmp/db.dump
docker exec -u postgres $PG pg_restore -U postgres -d remyral --exit-on-error /tmp/db.dump
docker exec $PG rm -f /tmp/db.dump
```

### 5.7 Verify before going live

```sh
install -d -m 0700 /data/remyral/prod/backups/db
cp /root/dr/db.dump /data/remyral/prod/backups/db/remana-prod-<stamp>.dump
cp /root/dr/remana-prod-<stamp>.manifest.json /data/remyral/prod/backups/db/
```

Then, after §5.8 has built the images (or with a locally built `remyral-backup:local`), run the drill project (§3):
it restores that dump once more into a throw-away server and checks schema, row counts, known entities and the
full audit chain against the manifest — the same checks prove the live restore in §5.6 started from intact data.

### 5.8 Bring the stack up

`REMYRAL_DEPLOY_HOST=<alias of the new host> REMYRAL_DEPLOY_DOMAIN_PROD=<console domain> node scripts/deploy/deploy.mjs`
from the operator's machine (empty deploy
state = first deploy; the restored DB has no pending migrations, so the missing pre-deploy backup only warns;
`--infra` if the Postgres/Redis definitions changed). The deploy builds and signs master, web and backup, runs
`migrate` (no-op or forward), starts master, web and the backup service, and passes the health gate. Redis starts
empty (correct, §1). In the console: log in (restored TOTP key — existing authenticator codes work), Audit → Verify
chain, Settings → Backups (first backup + drill on the new host), Machines (workers re-connect on their own).

### 5.9 Switch traffic and record the drill

Point the Cloudflare DNS record (or the Elastic IP) at the new host. Write down: start time, time per step,
total (RTO), the backup's age at the incident (RPO). Remove `/root/dr/` (`shred -u`). Rotate any credential
you suspect was on the lost host (deploy key, off-site token).

| Step | Measured |
|---|---|
| 5.1 new host | |
| 5.2–5.3 fetch + decrypt | |
| 5.6 restore | |
| 5.8 deploy + gate | |
| 5.9 DNS | |
| **RTO total** | |

## 6. Keys

- Generate (owner, once): backups.md §2 (`age-keygen` twice: primary + break-glass; `recipients.txt` = both public
  keys). Losing **both** identities makes every encrypted archive and off-site dump unreadable (local plaintext
  dumps on a surviving host stay usable).
- Rotate: new identity → add its public key to `recipients.txt` on the host → next run uses it; keep the old
  identity until the oldest off-site object encrypted to it has expired (100 days with the suggested lifecycle).
- The manifest lists the recipients each backup was encrypted to.

## 7. Alerts and troubleshooting

| Notification / console | Meaning | Action |
|---|---|---|
| `backup.failed` "Backup failed" | no usable backup from that run | `docker logs $B`; `remyral-backup check`; disk space; `REMYRAL_DB_BACKUP_PASSWORD` |
| `backup.failed` "Backup incomplete" | DB saved locally, secrets archive or off-site copy failed | recipients.txt present? off-site token valid (HTTP 403 = credentials/permissions)? |
| `backup.failed` "Backups are overdue" | no success for interval × 1.5 + 1 h | service running? (`docker ps`), previous failures |
| `backup.failed` "Backup service stopped" | no heartbeat for 30 min | `$C up -d --no-deps backup`; `docker logs $B` |
| `restore_drill.failed` "Restore drill failed" | the newest backup did not restore or a check failed | read the failed check in Settings → Backups; run `remyral-backup drill --backup <older id>`; a `dump_integrity` failure means the file changed on disk |
| `restore_drill.failed` "Restore drill overdue" | no passed drill for 8 days | drills disabled? service stopped? disk space (needs 4 × dump + 512 MiB free) |
| `backup.failed` "Standby WAL shipping is behind" (§10) | archived WAL has not reached off-site for 30 min (console: warning from 10 min, failing from 60 min) | off-site token/permissions (Settings → Standby readiness → Error), network, `docker logs $B`; a growing `walarchive` volume fills the disk |
| `backup.failed` "Base backup failed" (§10) | the daily physical base backup failed; restores keep using the previous base | grants missing (`backup-role.sql` → `base_backup = t`), `pgdata` mount, disk space; `docker exec $B remyral-backup base` |
| Console "WAL archive has a gap" | a segment is missing locally | the next base backup closes it (`remyral-backup base`); check disk errors |

## 8. Relation to the p1 host timer (backups.md)

Both can run side by side (different directories and targets). After one week of green backups and drills in the
console, retire the p1 timer and Garage, or keep the 15-minute timer if the 15-minute RPO is wanted without
`BACKUP_INTERVAL_MINUTES`: `systemctl disable --now remyral-backup@prod.timer` (owner decision; deploy.mjs prefers the
compose service for the pre-deploy backup as soon as it runs).

## 9. Tests

- `pnpm test` → `scripts/test/backup-runner.test.mjs` (naming, tiers, retention, schedule, manifest, recipients,
  SigV4 against the AWS documentation example, S3 single/multipart upload against a verifying fake server, status,
  migration check, audit chain), `apps/master/test/unit/backup-health.test.ts`, `backup-runner-parity.test.ts`,
  `apps/master/test/integration/backup-roundtrip.test.ts` (real `pg_dump --snapshot` → `pg_restore` on the dev
  Postgres, all drill checks, tamper detection), `backups-status.test.ts` (API, RBAC, notifications once),
  `apps/web/test/backups-settings.test.tsx`.
- `pnpm e2e:backup-drill` (Docker + age, ~40 s): builds the image and runs the real compose service against the
  production Postgres service definition — backup, encrypted secrets decrypted only by the owner identity,
  off-site copy to a fake S3, drill in the service and as its own project, tampered dump, private key refusal,
  daemon heartbeat.
- `pnpm e2e:backup-standby` (Docker + age, ~70 s, p11-master-resilience): production Postgres with `PG_WAL_ARCHIVE=on`,
  real migrations, base backup through the low-level API as the read-only `remyral_backup` role, rows written after the
  base shipped as WAL to a fake S3, the weekly drill with the standby replay, then the "fresh host": compose project
  down with its volume, `standby-restore.mjs fetch` + `restore`, compose Postgres adopts the restored volume and holds
  every row written after the base. Unit tests: `scripts/test/backup-standby.test.mjs` (WAL names/order/chain/gaps,
  shipping with fake age + S3, prune plan, base manifest/label, lease kid, schedule, off-site selection, data directory
  script, recovery settings, Cloudflare cutover with a fake API, S3 list/download), `backup-health.test.ts`
  (standby readiness), `backups-status.test.ts`, `backups-settings.test.tsx`.
- Not verified locally: uploads to real AWS S3 / Cloudflare R2 (the fake server checks the SigV4 signature,
  payload hash and Content-MD5; the SigV4 implementation reproduces AWS's published example), the first run on the
  EC2 host, a full §5 run on a fresh EC2 (p7-dr-drill); for the standby: WAL shipping to real S3/R2, a §11 standby
  restore on a fresh EC2, the Cloudflare API cutover against the real zone (backlog p11-master-standby-live).

## 10. Warm standby: continuous WAL archiving (p11-master-resilience)

One control-plane host plus object storage: the "standby" is the off-site **base backup + WAL** from which a fresh
host is brought up with `scripts/ops/standby-restore.mjs` (§11). No second always-on server is needed (a streaming
replica would need a second host; not part of this setup).

**How it works.** With `PG_WAL_ARCHIVE=on` the production Postgres runs with `archive_mode=on`, `archive_timeout=180`
and `wal_recycle=off`; its `archive_command` copies each completed 16 MiB segment durably (`dd conv=fsync`, temporary
name + rename; an identical existing copy counts as archived) into the compose volume `walarchive`. The backup
service, every 30 s: gzips each new segment into `backups/wal/<segment>.gz` (local copy, root:postgres 0640), encrypts it
to the owner's **public** keys and uploads it create-style (signed payload hash, SHA-256 re-read with HEAD) as
`<prefix>/wal/<env>/<segment>.gz.age` — strictly in WAL order, stopping at the first failure so the off-site chain never
has a hole — removes the raw segment, and prunes local copies older than the newest base backup once they are shipped.
Once a day (and at once when none exists) it takes a **physical base backup**: `pg_backup_start` → tar of the data
directory (the `pgdata` volume, mounted read-only into the backup service; `pg_wal/`, `postmaster.pid` and the other
directories the PostgreSQL docs list are left out) → `pg_backup_stop` (waits until the last needed segment is archived);
`backup_label` goes into the base manifest. Off-site: `<prefix>/base/<env>/<id>.base.tar.gz.age`, then `<id>.base.json`
(present ⇒ complete). The manifest records start segment, timeline, schema version and the **lease key id** (kid of the
lease-signing key) so a restore can prove the workers' pinned lease keys still verify. Progress goes to
`backups/status/standby.json` → Settings → Backups → *Standby readiness* (last WAL shipped, lag, base backup, last
standby drill). Nothing in it is secret.

**Weekly drill.** With WAL archiving on, the restore drill (§3) additionally extracts the newest local base into a
throw-away server (Unix socket only, no network), replays the local WAL copies through `restore_command`, waits for the
promotion at the end of the archive and checks: base integrity (SHA-256), WAL chain without gaps from the base's start
segment, promotion, schema vs this release's migrations, the full audit chain (`standby_*` checks; Settings → Backups
→ *Last standby drill*).

### 10.1 Enable (owner + operator)

1. Off-site copy configured (§3.2) — without it WAL stays on the host (useful only for an in-place point-in-time
   restore; Settings shows "kept on this host only").
2. Grants for the base backup on the **existing** cluster (new volumes get them from the initdb hook), as the
   superuser — run the updated `infra/backup/sql/backup-role.sql` (§3 of backups.md shows the `docker exec` line); it
   adds `GRANT EXECUTE ON FUNCTION pg_backup_start(text, boolean), pg_backup_stop(boolean) TO remyral_backup` (backup
   mode only: no read or write of any data; the role stays read-only) and prints `base_backup = t`.
3. `stack.env`: `PG_WAL_ARCHIVE=on`.
4. Deploy with **`--infra`** (`archive_mode` needs a Postgres restart; a few seconds of downtime — workers ride it out,
   ADR-0039). `docker exec $B remyral-backup check` → `"walArchive": "on"`, no problems. Within a minute
   `remyral-backup status` shows `standby.lastBaseBackup` and, after the next segment switch (≤ 3 min while anything is
   written), `standby.lastShippedSegment`.
5. Bucket lifecycle: expire `remyral/wal/` and `remyral/base/` after **15 days** (longer than the newest kept base needs).
   The existing upload-only token (PutObject/GetObject on `remyral/*`) covers both prefixes.

Disk: local WAL copies since the newest base (gzip; a quiet system writes ≤ 480 mostly-empty segments a day, a few MiB
compressed), one base backup (≈ the database size, gzip), plus the raw segments until the next 30-s pass.

Disable: `PG_WAL_ARCHIVE=off` + deploy `--infra`; `backups/wal/`, `backups/base/` and the off-site objects can then be
removed by hand.

## 11. Standby restore onto a fresh host (runbook; time every step)

Roles as in §5: the **owner** holds the age identity; the **operator** works on the new host. Commands run from a
checkout of the release that was running (§5.5).

1. **New host** — §5.1 (EC2 like the old one, `infra/ec2/bootstrap.sh`, Coolify's proxy network, SSH alias).
2. **Fetch** (owner's machine; or the new host with the identity on tmpfs, `shred -u` afterwards). `offsite-read.env`
   holds the same `BACKUP_S3_*` keys as `offsite.env` but a principal that may **list and read** the bucket
   (`s3:ListBucket` + `s3:GetObject`; R2: "Object Read only"):
   ```sh
   node scripts/ops/standby-restore.mjs fetch --env prod --offsite <operator-key-dir>/offsite-read.env \
     --identity <operator-key-dir>/identity.txt --out ~/standby-prod
   ```
   Downloads the newest complete base (manifest present), every WAL file from its start segment, the newest secrets
   archive; checks the ciphertext hashes, decrypts with `age -d`, checks the plaintext hash. `scp -r ~/standby-prod
   <new host>:/root/standby-prod` (mode 0700), then delete the local plaintext.
3. **Restore** (new host, root, Docker):
   ```sh
   node scripts/ops/standby-restore.mjs restore --env prod --staging /root/standby-prod [--target-time 2026-10-19T10:42:00Z]
   ```
   Restores `stack.env`/`secrets/`/`backup-config/` into `/data/remyral/prod` (kept if `stack.env` already exists),
   creates the compose volume `remyral-prod_pgdata` (refuses an existing one; `--force` replaces it), extracts the base,
   replays the WAL in a network-less `postgres:18.6-alpine` container (to `--target-time`, else to the end of the
   archive — e.g. a target just before a destructive mistake), waits for the promotion, removes the recovery settings
   again (`ALTER SYSTEM RESET`), verifies (promoted, schema vs this checkout's migrations, users/workers/jobs rows, audit
   chain, `totp.key`, `lease-signing.pem` with the base's lease kid) and removes the container. Any `FAIL` line: stop,
   do not switch traffic.
4. **Bring the stack up** — §5.8 (`REMYRAL_DEPLOY_HOST=<new host> node scripts/deploy/deploy.mjs`; `migrate` runs any
   newer migrations). Compose adopts the restored volume (labelled like its own).
5. **Verify live**: `node scripts/ops/standby-restore.mjs verify --env prod --staging /root/standby-prod --url https://<console host>/api/healthz`
   (run it after the DNS step, or against the new address with a hosts entry).
6. **Cutover** (Cloudflare DNS; the console host is proxied, so the change is effective in seconds):
   ```sh
   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ZONE_ID=<zone id> \
     node scripts/ops/standby-restore.mjs cutover --name <console host> --ip <new address> --dry-run   # shows old → new
   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ZONE_ID=<zone id> \
     node scripts/ops/standby-restore.mjs cutover --name <console host> --ip <new address>
   ```
   Token: Cloudflare dashboard → API Tokens → "Edit zone DNS" for this zone only; never on the server, never in argv.
   Manual alternative: dashboard → DNS → the console record → content = new address. (An Elastic IP moved to the new
   instance needs no DNS change at all.)
7. **Workers** reconnect on their own (backoff ≤ 60 s) to the same host name: their keys are in the restored `workers`
   table, the lease-signing key is the same (same kid), so sessions, pinned lease keys and running jobs' leases keep
   working; jobs whose lease epoch is still current continue (ADR-0039), others are reconciled as after any outage.
   The restored database is older than what the workers saw (the RPO window): both replay cursors catch up at the
   first session ("worker is ahead of the master outbox … numbering caught up" in the master log, "master is behind
   messages it had acknowledged" in the worker log) — expected, not an error; messages inside the RPO window are lost.
   A job still running on a worker whose outage exceeded its offline grace (~16.5 min) has fenced itself and is
   reconciled (retry only when verifiably safe).
8. Record the times (as in §5.9): fetch, restore, deploy, cutover, total = RTO; age of the last shipped WAL = RPO.
   Rotate the off-site token if the old host may be compromised.

## 12. Blobs (p17-object-storage)

Design: [docs/design/p17-object-storage.md](../design/p17-object-storage.md) §8, ADR-0064. Since migration 0154 job
outputs and other blobs are no longer in Postgres (after `remyral-master blobs:migrate`); the dump carries their rows
(key, size, SHA-256, location) and the sealed bucket keys.

**Local blob directory.** Every backup run mirrors `/blobs` (the master's `blobdata` volume, read-only) after the dump:
files are immutable, so each one is copied once — `age -r <owner keys>` into `backups/blobs/data/<key>.age` and, with
`offsite.env`, to `<prefix>/blobs/<env>/<key>.age`. In-flight uploads (`.uploads/`) and temporary files are skipped.
The run's `blobs` summary (files, bytes, copied, failed, removed) is in `status.json`; a failed copy makes the run
`partial` (Settings → Backups shows the warning). Without `recipients.txt` nothing is copied (blob copies are always
encrypted).

**Object storage.** Not copied. Enable bucket versioning and the lifecycle rules above; deleting the bucket or its keys
loses those blobs (the master never deletes a bucket and does not need list permission).

**Restore (local blobs).** After §4 / §5, on the owner's machine (or the DR host with the identity):

```sh
# Fetch backups/blobs/data (or <prefix>/blobs/<env>/ from off-site), then for every file:
find blobs-data -name '*.age' | while read -r f; do
  k="${f#blobs-data/}"; k="${k%.age}"
  install -d -m 0700 "restored/$(dirname "$k")"
  age -d -i <operator-key-dir>/identity.txt -o "restored/$k" "$f" && chmod 0600 "restored/$k"
done
# Copy restored/ into the new blobdata volume (owned by uid 10001):
docker run --rm -v "${P}_blobdata":/blobs -v "$PWD/restored":/in:ro alpine sh -c 'cp -a /in/. /blobs/ && chown -R 10001:10001 /blobs'
```

Then Settings → Diagnostics → **Dosya depolama** must be green and a recent output must download. A row whose blob is
missing (an older dump than the mirror, or a blob past its keep time) answers 410 `file_missing` and the job page shows
the file as removed — expected for blobs deleted before the backup that is restored.

**Restore (object storage).** Nothing to copy: the restored master reads the same bucket with the restored settings;
the master key file (`secrets/totp.key`) must be the restored one, else the sealed keys cannot be decrypted (Settings →
Integrations → Storage then says so; enter the keys again).

**Drill.** The weekly drill restores the dump only; once per quarter decrypt a sample of `backups/blobs/data` and
compare its SHA-256 with `blob_objects.sha256` of the restored database:
`psql -Atc "select key, sha256 from blob_objects where location = 'local' order by random() limit 20"`.

