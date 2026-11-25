# Design note: off-host encrypted backups (P1)

- **Status:** Implemented (S3 path unverified until the first install — docs/ops/backups.md §8)
- **Date:** 2026-10-13
- **Backlog:** p1-backups (feeds p7-dr-drill / A-SEC-5, p1-gate restore rehearsal)
- **Decisions applied:** ADR-0003 (Postgres is the durability boundary, Redis is not), ADR-0006 (secrets
  handling), docs/ops/slo.md (RPO ≤ 15 min, RTO ≤ 2 h)
- **Threat model:** T-SEC-4 (backups leak data), T-OPS-5 (data loss), AS-9 (backups contain everything)

## 1. Decisions

| Question | Decision | Why |
|---|---|---|
| Where does it run? | **Host systemd timer** (`remana-backup@<env>.timer`), `pg_dump` via `docker exec` inside the env's Postgres container | No new long-running container or image; `pg_dump` is exactly the server's version (dump format compatibility is guaranteed); the instance role's credentials come from IMDSv2 on the host — a container would need the IMDS hop limit raised to 2, which would also hand AWS credentials to every other container (master, web, Coolify's). systemd gives `Persistent=` catch-up, journald logs and a sandbox (`ProtectSystem=strict`). Cost: host packages (`age`, AWS CLI v2). A Coolify scheduled task was rejected: it runs inside an app container (same IMDS problem) and is not in the repo. |
| RPO ≤ 15 min | **Logical dumps every 15 min**, not WAL archiving | The DB is small (hundreds of KB today; dump in seconds), so 15-min dumps meet the SLO with worst-case loss 15 min + dump time. WAL-G would give seconds of RPO and PITR but needs a custom Postgres image (binary + `archive_command`), AWS credentials inside the DB container (IMDS hop limit), a base-backup/retention scheme that deletes objects (conflicts with the no-delete, create-only bucket) and a far more complex restore — more failure modes than the SLO needs. Re-evaluate (move to WAL-G with PGP/age-encrypted segments and a separate prune role in the backup account) when a dump takes > 2 min, the DB exceeds ~5 GB, or the RPO target drops below 15 min. Each dump is a consistent snapshot (`pg_dump` uses one repeatable-read transaction). |
| Encryption | **age** to the owner's public keys (primary + offline break-glass) | Authenticated streaming encryption, tiny CLI, keys are one line; no private key on the host (enforced). OpenSSL `enc` has no AEAD/public-key mode; `openssl cms` works but decrypts non-streaming and is easy to misuse. KMS was rejected as the only layer: anyone with the instance role (= host root) could decrypt. SSE-S3 stays on as a second layer. |
| DB credentials | Dedicated role `remyral_backup`: `pg_read_all_data`, `default_transaction_read_only`, nothing else | `remyral_owner` (the old plan in deploy-coolify.md §8) can run DDL; a stolen backup credential must not be able to change anything. Proven by the e2e (insert/create/temp/update denied). |
| Storage | S3 bucket in a **separate account**, **us-west-2**, versioning + Object Lock governance 14 d + lifecycle; create-only writes (`If-None-Match: *`, enforced by bucket policy) | Host compromise cannot delete, overwrite or shorten retention of existing backups; region failure of us-east-1 does not take the backups with it; a compromised prod account cannot touch the backup account's bucket configuration. |
| Secrets | `stack.env` + `secrets/` as an age-encrypted tar, on change and daily | Without `totp.key` every TOTP enrolment is lost; without the DB passwords the compose stack cannot be recreated identically. They are encrypted to the same owner keys. |
| Redis | Not backed up | ADR-0003: Redis loss is recoverable from Postgres by the reconciliation loop (p4-chaos proves it). A restored Redis would even be harmful (stale leases/jobs relative to the restored DB). |
| Integrity metadata | Plaintext manifest per object: SHA-256 of ciphertext and plaintext, sizes, versions, last migration, audit head `id:hash` | Restore can reject substituted/corrupted objects before decrypting, verify the decrypted bytes, and check that the restored audit chain reaches the head recorded at backup time. The manifest leaks nothing secret (hashes of encrypted/compressed data, version numbers). |

## 2. Flow

```
systemd timer (*:00/15) ─▶ backup.sh (root, sandboxed)
   docker exec <pg> pg_dump -Fc -U remyral_backup ─┬─▶ sha256 + size (plaintext, in memory)
                                                  └─▶ age -R recipients.txt ─▶ $tmp/db.dump.age
   manifest.json ─┐
   db.dump.age ───┴─▶ aws s3api put-object --if-none-match '*' --checksum-algorithm SHA256
                      --expected-bucket-owner <backup acct>   (or file:// no-clobber copy)
   tar stack.env secrets/ ─▶ age ─▶ same (only when changed, and daily)
   ─▶ /var/lib/remana-backup/<env>/last-success + CloudWatch BackupSucceeded
```

Restore (`restore.sh`) is the inverse and runs where the identity is: fetch → ciphertext hash vs manifest
→ `age -d` → plaintext hash vs manifest → `pg_restore --single-transaction --exit-on-error` into a fresh
container (roles and database-level grants created like the initdb hook) or into an **empty** database of
an existing container (DR path) → checks `schema_migrations` head and audit head.

## 3. Security review

- **Host root compromise:** can read the live DB anyway; can read old encrypted backups but not decrypt
  them; cannot delete/overwrite/re-lock them (bucket policy deny + Object Lock); can stop backups → the
  CloudWatch "missing data" alarm fires within 30 min; can upload junk under new keys → restore verifies
  manifest hashes and age authentication, and the owner picks the object.
- **Backup account compromise:** sees only ciphertext; governance retention blocks casual deletion
  (an admin with `BypassGovernanceRetention` can still delete — accepted; compliance mode is the upgrade).
- **Owner key loss:** two independent identities (one offline). Both lost = backups useless; documented.
- **Secrets in transit/at rest on the host:** the DB password is read from `stack.env` and passed to
  `docker exec` via the environment (not argv); the plaintext dump exists only in a pipe; temp files are
  ciphertext in a 0700 `mktemp` dir under the unit's `PrivateTmp`. Nothing secret is logged.
- **Restore safety:** refuses a non-empty target database; single transaction; the fresh container's
  roles are `NOLOGIN` and its port is not published unless asked (and then only on 127.0.0.1).
- **Supply chain:** `age` from Ubuntu's archive; AWS CLI v2 via AWS's signed installer (owner step).

## 4. Rollback

Remove with `systemctl disable --now remana-backup@prod.timer`; the role can be disabled with
`ALTER ROLE remyral_backup NOLOGIN`. Nothing in the application depends on it. The compose change is
backward compatible (`REMYRAL_DB_BACKUP_PASSWORD` optional; only affects first initialisation).
