# ADR-0064: Job outputs and other blobs in object storage or the master's disk, never in Postgres

- **Status:** Accepted
- **Date:** 2026-10-24
- **Deciders:** owner (decisions 2026-10-24), agent
- **Related:** p17-object-storage; [design note](../design/p17-object-storage.md); p5-research-workspace (artifact
  chunks), p6-outputs, p8-preview-tunnels (app packages), ADR-0028 (master-held integration secrets), ADR-0039
  (backups / standby), ADR-0056 (security policy events); migration 0154

## Context

Every job output, input, uploaded site file, worker release and installer kit was stored as Postgres `bytea` (761 MB
of the 761 MB-class database on prod, carried by every dump), and outputs travelled base64 in WebSocket messages, which
capped them at 5 MiB per file (80 MiB for app packages). The owner wants installers (APK/AAB/IPA, Windows setup/MSI,
macOS DMG/PKG), archives, videos and large analysis data to be produced and downloaded — up to about 2 GB per file —
with downloads through short-lived signed links, a time-limited share link, configurable limits and per-project
retention, and the existing blobs moved out of the database.

## Decision

1. **Where blobs live.** An S3-compatible bucket (AWS S3, Cloudflare R2, MinIO) when the owner configures one in
   Ayarlar → Entegrasyonlar → Depolama, else the master's local blob directory (a volume, `BLOB_DATA_DIR`). New blobs
   are never written to Postgres; rows keep metadata (name, type, size, SHA-256) and a `blob_key`. Every blob records
   its location, so switching stores never breaks existing blobs. `remyral-master blobs:migrate` moves the existing
   bytea content (verified per row) and nulls the columns.
2. **Keys of the bucket are an integration secret** (ADR-0028 scheme: AES-256-GCM under the HKDF sub-key
   `ops-integrations`, AAD `object-storage`): entered only by the **owner** with an always-fresh code (security-policy
   event `integrations.connections`), never returned, logged, audited (fingerprint only), sent to a worker or shown to
   the assistant. Choosing a bucket requires a passing put / head / get / delete round trip.
3. **Workers upload large outputs directly** (feature `blob-upload-v1`) with a master-issued grant for one key, one size
   and one SHA-256, fenced by the job's live lease: presigned PUT / UploadPart URLs (object storage) or the master's own
   endpoint with a one-time token (local disk). **The master reads every uploaded object back and checks size, SHA-256
   and magic bytes before it is committed** — a checksum header is not trusted to be enforced by every compatible
   provider. Older workers keep the chunk path and its limits; older masters never offer the blob path.
4. **Downloads** are a 302 to a presigned GET with a forced attachment and a short lifetime (owner-set, default 5 min),
   or the file streamed with the existing attachment headers (local disk). **Share links**: owners / admins only, a
   fresh code (`data.access`), ≤ 30 days (owner-set maximum, default 7), revocable, token stored hashed, every opening
   audited.
5. **A small SigV4 implementation instead of the AWS SDK**: the master needs eight S3 operations and presigning; the
   signer is checked against the S3 documentation's examples and a real S3-compatible server. The dependency surface of
   the master image stays as it is.
6. **Backups:** Postgres keeps the metadata; the local blob directory is mirrored by the backup runner (encrypted to the
   owner's age keys, off-site like the dumps); a bucket is its own system of record (versioning + lifecycle
   recommended), not copied by the runner.

## Consequences

- Outputs up to 2 GiB − 1 B per file (the `integer` size column), 5 GiB per job by default; nine new output types,
  download-only, never inputs, never previewed inline on the console.
- The database and its dumps shrink by ~640 MB after the migration; the blob volume (or bucket) must be sized and backed
  up — Doctor checks the store and the local free space and lists bytes still in Postgres.
- A worker release is needed for the direct-upload path; nothing breaks without it.
- Rolling the master back needs `blobs:migrate --to-db` first; blobs above the old limits stay unreadable for an older
  master.
- Residual risks: compressed archive entries are not unpacked for the secret scan; the master does not re-scan blob
  uploads (it verifies integrity and type).

## Amendment 2026-10-27: output limits decided by bytes, overflow zip (p17-output-limits)

Owner 2026-10-27: "bu sınır mantıklı değil: İş başına en fazla 20 çıktı dosyası" — "500 uygun, üstü olursa zip seçeneği
ile devam edilebilir". Design: [p17-output-limits](../design/p17-output-limits.md).

- **The count is a setting, not a storage limit:** output files per job default 500 (inline + blob together), owner
  setting `jobs.outputMaxFiles` (environment `JOB_OUTPUT_MAX_FILES`), a workspace project may only lower it, hard
  ceiling 2000. The blob store's per-job bytes may likewise be lowered per project (ceiling 64 GiB). The limits in force
  are recorded on the attempt at assignment; the master checks staging, commits and grants against that record.
- **Bytes decide the path:** the inline path (Postgres staging) keeps its byte budget (5 MiB per file, 15 MiB per
  attempt) and is no longer counted against blob uploads; every file that does not fit it goes to the blob store (any
  allowed type). Without a usable store: inline only, the count unchanged.
- **Overflow zip:** files beyond the count or the per-job bytes are packed by the worker into one `out-rest.zip` (paths
  kept; allowlist, redaction and secret scan per entry; symlinks never followed; ≤ 10 000 entries, ≤ 2 GiB − 1 B and the
  blob limits) uploaded through the verified blob path; what still does not fit is reported with a reason code.
- **Reported, never silent:** JOB_RESULT `outputs` plus the master's own refusals → `GET /jobs/:id/output-report`, shown
  on the job page and in the chat card. "Hepsini indir": `GET /jobs/:id/artifacts/all.zip`, streamed from the store.
- **Compatibility:** feature `output-limits-v1`; older workers keep 20 inline + 20 blob files (the master enforces
  that for them). Master first, then the worker release.
- **Residual risk (unchanged in kind):** an agent's own zip, and the overflow zip as a whole, are not unpacked for the
  scan by the master; the overflow zip's entries were scanned by the worker before compression.
