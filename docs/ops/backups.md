# Off-host encrypted backups

> **p10-backup-restore:** the compose backup service with local + off-site copies, a weekly restore drill and the
> full disaster-recovery runbook is in [backup-restore.md](backup-restore.md); this page (p1 host timer + Garage)
> stays valid until that service has replaced the timer on the host (backup-restore.md §8). The owner keys of §2
> are the same.

Covers `p1-backups` (threat model T-SEC-4 "backups leak data", T-OPS-5 "data loss"; SLO RPO ≤ 15 min,
RTO ≤ 2 h — [slo.md](slo.md)). Design rationale: [docs/design/p1-backups.md](../design/p1-backups.md).
The restore drill on a fresh EC2 (A-SEC-5) is `p7-dr-drill`; §7 is its runbook.

| File | Purpose |
|---|---|
| `infra/backup/backup.sh` | One backup run: `pg_dump -Fc` → `age` → create-only upload, + recovery secrets. |
| `infra/backup/restore.sh` | `list`, `postgres` (fresh container or empty existing DB), `secrets`. Runs where the owner's key is. |
| `infra/backup/lib.sh` | Shared helpers; the storage interface (`s3://` and `file://`). |
| `infra/backup/install.sh` | Installs the timer on the host (idempotent, `--dry-run`). |
| `infra/backup/systemd/remyral-backup@.{service,timer}` | Every 15 min, per environment (`@prod`, `@staging`). |
| `infra/backup/sql/backup-role.sql` | One-off: create/enable `remyral_backup` on an existing database. |
| `infra/backup/aws/*.json` | Instance-role policy, bucket policy, Object Lock, lifecycle (placeholders in CAPS). |
| `scripts/e2e/backup-roundtrip.mjs` | `pnpm e2e:backup`: backup → restore round trip, tamper and DR checks (18). |

> **p17-host-actions (2026-10-26):** on a `remyral-ctl` host the owner manages backups from Ayarlar → Yedekler →
> Yedekleri yönet (backup now, drill, schedule / retention / WAL / recipients, off-site target, restore); the host
> applies the settings into stack.env and `backup-config/`. This runbook stays the reference for the vendor's own
> Coolify / EC2 production (no host applier there) and for disaster recovery.

## 1. What is backed up, where, how often

| What | How | Tier / retention |
|---|---|---|
| Postgres `remyral` (all state, incl. the hash-chained audit log) | `pg_dump -Fc` as `remyral_backup` (read-only) inside the Postgres container | every 15 min → `frequent/` 14 days; first run of each UTC day → `daily/` 400 days (Glacier IR after 30 d) |
| Recovery secrets: `/data/remyral/<env>/stack.env` and `secrets/` (`totp.key`, `lease-signing.pem`, optional SMTP/webhook/GitHub keys) | `tar --numeric-owner` | uploaded when their content/mode/owner changes, and daily |
| Master-held integration tokens (every Coolify connection — p13-multi-coolify —, Cloudflare, Bedrock) | in Postgres (`coolify_connections.secret`, `ops_integrations.secret`), AES-256-GCM under a sub-key of `secrets/totp.key`: the DB dump carries the ciphertext, the recovery secrets the key; neither alone reveals a token | with the two rows above |
| Redis | **not backed up** — not a durability boundary (ADR-0003): queues are rebuilt from Postgres by the reconciliation loop; AOF covers restarts. After a restore, start with an empty Redis. | — |
| Coolify itself | not covered (it is not running Remyral yet); re-install from `infra/ec2/bootstrap.sh` | — |

Object keys: `remyral/<tier>/<env>/<postgres|secrets>/<YYYY>/<MM>/<DD>/<UTC stamp>.{dump,tar}.age` plus
`….manifest.json` (plaintext: hashes of ciphertext and plaintext, sizes, server/pg_dump versions, last
migration, audit head `id:hash`, recipients). Bucket: **separate AWS account**, region **us-west-2**,
versioning + **Object Lock (governance, 14 days default)** + lifecycle + SSE-S3; the host can only
create (never overwrite, never delete) and read.

**RPO.** Dumps every 15 min (timer `*:00/15`, `Persistent=true`): worst-case loss is 15 min plus the dump
duration (seconds at the current size). See the design note for why this beats WAL archiving for now and
when to switch (dump > 2 min or DB > ~5 GB).

**Encryption.** `age` (X25519 + ChaCha20-Poly1305, authenticated, streaming) to the owner's **public**
keys. The plaintext dump never touches the host's disk; the host holds no key able to decrypt (backup.sh
refuses to run if the recipients file contains a private key). Integrity: SHA-256 of the ciphertext and of
the plaintext in the manifest, both checked by `restore.sh`; age rejects any modified or truncated file.

## Garage target (single-host option)

Instead of AWS S3 the timer can write to a **Garage** S3-compatible store on the control-plane host (MinIO is not
offered: its upstream is archived and no longer patched).

- Container: `infra/garage/compose.yaml` (dxflrs/garage v2.3.0 pinned by digest), project `remyral-garage`,
  S3 API on **127.0.0.1:3900 only**, single node, volumes `remyral-garage_garage-{meta,data}`.
- Setup: `sudo infra/garage/setup.sh` (config with random rpc/admin secrets in `/data/remyral/garage/garage.toml`,
  bucket `remyral-backups`, key `remyral-backup` → `/etc/remyral/backup/garage-credentials`, root 0600).
- Timer installed with `--target s3://remyral-backups/remyral --region garage --endpoint http://127.0.0.1:3900
  --credentials /etc/remyral/backup/garage-credentials`. `lib.sh` uses the credentials file instead of the
  instance role for this endpoint and checks for an existing key before every put (Garage ignores
  `If-None-Match`).
- Check after setup: the first daily and 15-minute dumps appear in the bucket, and a restore of the latest dump
  (`restore.sh`, run where the owner key is — for example through an SSH tunnel to the Garage port) shows the
  expected tables, migration and audit head.

**Limits.** A single-node Garage on the same host shares the disk with the database. It protects against
accidental deletion and logical corruption, **not** against losing the instance or its volume, and not against a
host compromise: anyone with root on the host can delete the Garage objects, and this setup has no Object Lock.
A restore to a fresh machine needs a copy that survives the instance. What to do about it:

- Copy the bucket to an off-instance target on a schedule (another machine running Garage, or S3 in a separate
  account; `aws s3 sync` with the same credentials is enough).
- Where the target supports it, enable versioning and **Object Lock** on the off-instance copy so that the host's
  credentials cannot delete or overwrite what is already there.
- Treat a backup that has never been restored as unverified: run the restore drill against the off-instance copy.

Keys: keep the primary age identity in a password manager and the break-glass identity offline (§2); neither
belongs on the host.

## 2. Owner: create the backup keys (on your own machine, once)

`<operator-key-dir>` below is a directory of your choice on that machine (not on the server), for example a folder in
your home directory; the commands keep it at mode 700.

```sh
brew install age
mkdir -p <operator-key-dir> && chmod 700 <operator-key-dir> && cd <operator-key-dir>
age-keygen -o identity.txt            # primary; prints "Public key: age1…"
age-keygen -o break-glass.txt         # second key, stored OFFLINE (printed / USB in a safe)
age-keygen -y identity.txt  >  recipients.txt
age-keygen -y break-glass.txt >> recipients.txt
```

- Store `identity.txt` in the password manager (secure note) and keep the file on the Mac at 0600.
  `break-glass.txt` goes offline; delete the online copy after printing/storing it. Losing **both** makes
  every backup unrecoverable; any one of them restores everything.
- `recipients.txt` (two `age1…` lines) is public and is what the server gets. Never copy an
  `identity`/`break-glass` file to the server.
- p16-ops-safety: the master cannot see the identity, so record its date once (and after every rotation) — Settings →
  Operations safety → Keys and expiry → *Backup age identity* → *Yenilendi*, or on the host
  `remyral-master secrets:rotated backup:age-identity --at <ISO date>`; reminders come before the yearly rotation.
- Rotation: generate a new identity, add its public key to `recipients.txt`, re-run `install.sh`; keep the
  old identity until the oldest backup encrypted to it has expired (400 days).

## 3. Database role `remyral_backup`

`remyral_backup`: `LOGIN`, member of `pg_read_all_data` (reads every table/sequence), no write privilege,
owns nothing, `default_transaction_read_only = on`, no superuser/createdb/createrole/bypassrls. Its
password is `REMYRAL_DB_BACKUP_PASSWORD` in `stack.env` (hex, unquoted: `openssl rand -hex 32`).

- **New volumes**: set `REMYRAL_DB_BACKUP_PASSWORD` in `stack.env` (Coolify: secret variable) **before** the
  first start; the compose initdb hook creates the role. Without it the hook creates the role `NOLOGIN`.
- **Existing production database** (initialised 2026-10-13, before this hook) — once, on the host:

  ```sh
  sudo sh -c 'umask 077; printf "REMYRAL_DB_BACKUP_PASSWORD=%s\n" "$(openssl rand -hex 32)" >> /data/remyral/prod/stack.env'
  PG=$(sudo docker ps -qf label=com.docker.compose.project=remyral-prod -f label=com.docker.compose.service=postgres)
  sudo docker exec -i --env-file /data/remyral/prod/stack.env -u postgres "$PG" \
    psql -U postgres -d remyral -X -v ON_ERROR_STOP=1 -f - < /opt/remyral-src/infra/backup/sql/backup-role.sql
  # last line must read: remyral_backup|t|f|f|t
  ```

  The variable is unused by the running services until the next `compose up` (where it is optional), so
  adding it needs no restart.

## 4. AWS setup

### 4.1 Backup account (separate account; owner, with an admin profile of THAT account)

Replace `BACKUP_ACCOUNT_ID`, `PROD_ACCOUNT_ID` and choose the bucket name (global): e.g.
`remyral-backups-<BACKUP_ACCOUNT_ID>-usw2`.

```sh
P=--profile=remyral-backup-admin R=us-west-2 B=remyral-backups-BACKUP_ACCOUNT_ID-usw2
aws s3api create-bucket $P --region $R --bucket $B \
  --create-bucket-configuration LocationConstraint=$R --object-lock-enabled-for-bucket   # also enables versioning
aws s3api put-public-access-block $P --bucket $B --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-ownership-controls $P --bucket $B \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'        # backup account owns every object
aws s3api put-bucket-encryption $P --bucket $B --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
aws s3api put-object-lock-configuration $P --bucket $B --object-lock-configuration file://infra/backup/aws/object-lock.json
aws s3api put-bucket-lifecycle-configuration $P --bucket $B --lifecycle-configuration file://infra/backup/aws/lifecycle.json
sed -e "s/BACKUP_BUCKET/$B/g" -e 's/PROD_ACCOUNT_ID/<prod account id>/g' infra/backup/aws/bucket-policy.json > /tmp/bp.json
aws s3api put-bucket-policy $P --bucket $B --policy file:///tmp/bp.json
```

Bucket policy (`infra/backup/aws/bucket-policy.json`), in words: the prod `instanceRole` may
`PutObject`/`GetObject` under `remyral/*` and `ListBucket` with prefix `remyral/*`; **every** prod-account
principal is denied any `PutObject` without `If-None-Match` (create-only: no overwrite of an existing key),
and denied delete / retention / legal-hold / ACL / policy / lifecycle / versioning / Object Lock changes;
non-TLS requests are denied for everyone. Object Lock **governance** 14 days: not even the backup account
can delete a version inside the window without `s3:BypassGovernanceRetention` (grant that to nobody day to
day; compliance mode was not chosen because it cannot be undone if a retention mistake is made — revisit
at go-live).

### 4.2 Production account: the instance role

```sh
sed -e "s/BACKUP_BUCKET/$B/g" -e 's/BACKUP_ACCOUNT_ID/<backup account id>/g' \
  infra/backup/aws/instance-role-policy.json > /tmp/ip.json
aws iam put-role-policy --profile=<prod admin> --role-name instanceRole \
  --policy-name remyral-backup-s3 --policy-document file:///tmp/ip.json
```

Exact policy (least privilege — no `Delete*`, no `PutObjectRetention`, nothing outside `remyral/*`; the
`s3:ResourceAccount` condition pins the bucket to the backup account):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "RemyralBackupWriteRead", "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::BACKUP_BUCKET/remyral/*",
      "Condition": { "StringEquals": { "s3:ResourceAccount": "BACKUP_ACCOUNT_ID" } } },
    { "Sid": "RemyralBackupList", "Effect": "Allow", "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::BACKUP_BUCKET",
      "Condition": { "StringEquals": { "s3:ResourceAccount": "BACKUP_ACCOUNT_ID" },
                     "StringLike": { "s3:prefix": ["remyral/*"] } } }
  ]
}
```

The role already has `CloudWatchAgentServerPolicy` (`cloudwatch:PutMetricData`) for the success metric.

### 4.3 AWS CLI v2 on the host

Not in Ubuntu's archive; install with AWS's installer and verify its signature as described in the AWS CLI
user guide ("Install or update to the latest version of the AWS CLI → Linux → verify the integrity"),
then `aws --version` must print `aws-cli/2.…`. The snap is not used: `snap-confine` does not run inside
the unit's `NoNewPrivileges`/`ProtectSystem=strict` sandbox. Check the role from the host:
`aws sts get-caller-identity` → `…:assumed-role/instanceRole/i-…`.

## 5. Install on the host (orchestrator runs this on the host)

```sh
scp recipients.txt <host>:/tmp/recipients.txt      # public keys only
ssh <host> 'cd /opt/remyral-src && sudo infra/backup/install.sh --env prod \
  --target s3://remyral-backups-BACKUP_ACCOUNT_ID-usw2/remyral --region us-west-2 \
  --expected-owner BACKUP_ACCOUNT_ID --recipients /tmp/recipients.txt --dry-run'
# then the same without --dry-run, and the first run:
ssh <host> 'sudo systemctl start remyral-backup@prod.service; sudo journalctl -u remyral-backup@prod -n 20 --no-pager'
ssh <host> 'systemctl list-timers "remyral-backup@*"'
```

Staging: same with `--env staging` (compose project `remyral-staging`, `/data/remyral/staging/…`).

## 6. Monitoring

- Every successful run publishes `Remyral/Backup` → `BackupSucceeded` (=1, dimension `Env`) and
  `BackupBytes` in us-east-1, and writes `/var/lib/remyral-backup/<env>/last-success` (epoch).
- Alarm (owner, prod account): `Sum(BackupSucceeded) < 1` over **30 min**, **treat missing data as
  breaching** → SNS → page (feeds p6-alerts). Also alarm when `BackupBytes` drops by > 50 % day over day
  (a truncated DB is still a "successful" dump).
- Failures are in `journalctl -u remyral-backup@prod` (no secrets are logged).

## 7. Restore

Everything runs where the identity is (owner's Mac, or the DR instance with the identity copied in for the
drill and deleted afterwards). Needs Docker, `age`, and for S3 the AWS CLI with a principal allowed to
read the bucket (the backup-account admin profile, or `instanceRole` on a replacement EC2).

```sh
export BACKUP_S3_REGION=us-west-2 BACKUP_S3_EXPECTED_OWNER=BACKUP_ACCOUNT_ID AWS_PROFILE=remyral-backup-admin
T=s3://remyral-backups-BACKUP_ACCOUNT_ID-usw2/remyral
infra/backup/restore.sh list --target $T --env prod | tail
# Inspect a point in time in a throw-away container (roles NOLOGIN; prints the container name):
infra/backup/restore.sh postgres --target $T --env prod --from latest \
  --identity <operator-key-dir>/identity.txt --fresh
docker exec -it -u postgres <container> psql -d remyral      # then: docker rm -f -v <container>
# A specific object instead of latest:
infra/backup/restore.sh postgres --target $T --from daily/prod/postgres/2026/10/14/20261014T000012Z.dump.age …
```

### 7.1 Disaster recovery onto a fresh host (runbook for p7-dr-drill; time each step)

1. Provision the EC2 (`infra/ec2/bootstrap.sh`), Coolify proxy network, AWS CLI v2, `age`, the role policy.
2. Restore the secrets: `restore.sh secrets --target $T --env prod --from latest --identity … --out /tmp/rs`
   (as root), then `install -d -m 0700 /data/remyral/prod && mv /tmp/rs/stack.env /tmp/rs/secrets /data/remyral/prod/`.
   Ownership (uid 10001) and modes (0400) are preserved by tar.
3. Rsync the source tree of the **tag recorded in the deploy log** for the dump's `lastMigration` (an older
   build refuses a newer schema; see cicd.md) and build/load the images.
4. Start only Postgres: `docker compose -p remyral-prod --env-file /data/remyral/prod/stack.env -f infra/coolify/compose.yaml up -d --wait postgres`
   (the initdb hook creates the roles with the restored passwords).
5. `restore.sh postgres --target $T --env prod --from latest --identity … --container <pg container>` —
   refuses a non-empty database, restores in one transaction, checks `schema_migrations` head and that the
   manifest's audit head (`id:hash`) is present.
6. `compose up -d` (migrate is a no-op; master starts), then the smoke test of deploy-coolify.md §6, then
   verify the audit chain from the console/`verifyChain`. Redis starts empty — expected.
7. Point DNS (Cloudflare) / Elastic IP at the new host. Record the measured RTO.

## 8. Tests

`pnpm e2e:backup` (Docker + `age`; ~30 s; touches neither the dev stack nor its DB): the production
Postgres service with its initdb hook in a throw-away compose project, the real migrations as
`remyral_owner`, data as `remyral_app`; checks the backup role's read-only rights and the one-off SQL;
`backup.sh --dry-run`; refusal of a private key on the server; two runs (daily + frequent tiers, secrets
de-duplicated); create-only target; no decryption key on the server; restore into a fresh container
(all 65 tables identical, owners/grants/append-only triggers intact); break-glass key restoring the older
point in time; tampered ciphertext / forged manifest / foreign identity rejected; secrets restored
byte-identical with modes; the DR path (new compose project from the restored `stack.env`, restore into
it, log in with the restored passwords, second restore refused).

The storage target in the test is `file://` — the same create-only interface as `s3://` in `lib.sh`. **Not
verified locally (no MinIO to save disk; no AWS access):** the `aws s3api put-object --if-none-match
--checksum-algorithm SHA256 --expected-bucket-owner` call against the real bucket, the bucket policy's
`s3:if-none-match` condition, Object Lock interplay, the CloudWatch metric, and the systemd sandbox on
Ubuntu 26.04. Verify on the first install: run the service once, then
`aws s3api put-object --bucket $B --key remyral/x --body /etc/hostname` from the host must fail (403:
no If-None-Match), and `aws s3api delete-object` must fail (403).
