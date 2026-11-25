# p17-object-storage — job outputs and other large blobs in object storage, never in Postgres

- **Task:** `p17-object-storage`. **Date:** 2026-10-24. **ADR:** [ADR-0064](../adr/0064-object-storage-for-blobs.md).
- **Owner decisions (2026-10-24):** S3-compatible object storage (AWS S3, Cloudflare R2, MinIO for self-host); without
  one, the master's local disk (a volume) — **never Postgres for new blobs**. The owner enters the keys in the panel
  (Ayarlar → Entegrasyonlar → Depolama). Downloads through short-lived signed links; optional "S3'te aç" and a
  shareable time-limited link. Configurable limits (up to 2 GB per file). Per-project retention. Existing blobs move
  out of the database.
- **Migration:** 0154 (`blob_objects`, `blob_key` on five tables, `object_storage_settings`, `blob_uploads`,
  `blob_share_links`).
- **Protocol:** additive in 1.0 — worker feature `blob-upload-v1`, ASSIGN_JOB `execution.blobUpload`,
  BLOB_UPLOAD_REQUEST / GRANT / COMPLETE / STATUS (control job messages), ARTIFACT_REF `blobUploadId`, nine new
  output types (`exe msi dmg pkg zip tar.gz tgz mp4 webm`, flag `large`).
- **Release:** master + web + backup image together; a **worker release** for direct uploads (older workers keep
  working on the chunk path, §4.6). After the deploy: `remyral-master blobs:migrate` (§7).

## 1. Starting point (verified on prod 2026-10-24)

| Table | Bytes | What |
| --- | --- | --- |
| `worker_release_installer_kits.content` | 347 MB | signed installer kits per OS and version |
| `worker_releases.artifact` | 138 MB | worker release bundles |
| `job_artifacts.content` | 109 MB | job outputs, summaries, site bundles, integration reports, function results |
| `site_upload_files.content` | 34 MB | uploaded static sites |
| `job_inputs.content` | 13 MB | job input files |

761 MB in total; every nightly dump carried them. Outputs were capped at 5 MiB per file / 15 MiB per attempt (app
packages 80 MiB) because every byte travelled base64 in ARTIFACT_CHUNK messages through the WebSocket into a staging
table and then into a bytea column. S3 was used only by the backup runner (infra/backup/runner/lib/s3.mjs).

## 2. Model

- **`blob_objects`** — one row per stored blob: `key` (grammar `^(artifacts|inputs|site-uploads|releases|kits)/…`,
  id-based: `artifacts/<job>/<attempt>/<artifact>`, `inputs/<job>/<input>`, `site-uploads/<upload>/<idx>`,
  `releases/<version>/bundle-<rand>`, `kits/<version>/<os>-<rand>`), `kind`, **`location`** (`local` | `s3`),
  `store_ref` (`<endpoint host>/<bucket>/<prefix>` at write time, no credentials), size, SHA-256, `verified_at`.
- **`blob_key`** on `job_artifacts`, `job_inputs`, `site_upload_files`, `worker_releases`,
  `worker_release_installer_kits` (FK `ON DELETE RESTRICT`). A row's bytes are the legacy bytea column **or** its blob
  (`*_one_store_check` / `*_store_check`); a pruned row has neither (`*_pruned_check` rewritten for that).
- **Write protocol** (`BlobService.write`): register the `blob_objects` row (autocommit) → put the bytes → the caller's
  transaction sets its row's `blob_key`. A crash or rollback in between leaves an *unreferenced* blob, which the GC
  removes (§6.3) — never a row pointing at missing bytes.
- **Reads** go through `rowContent(row)` (`blobs/registry.ts`): the bytea when still set, else the blob. Every former
  reader of these columns was moved: workspace files (download, preview, inputs from artifacts, continue-from,
  upstream steps, sub-job delivery, input slices by range), outputs (ZIP, site preview), verify (docs, bundle, verifier
  report and its screenshots — written to the store too), integration reports, function results, Pages deploys (output
  files and site bundles), chat mentions (job summaries), site uploads, worker release downloads and installer kits.
  `content IS NULL` meaning "pruned" was replaced by `pruned_at` where it was used.
- **The process's store** (`blobs/registry.ts`) is set once by `createMasterApp` (and the CLI): the reads above live in
  a dozen services and pure helpers whose bytes used to come straight from a column; threading the store through all
  constructors would not make it more testable (they read through the same Postgres row anyway). A process without a
  store fails loudly (`blob store not configured`), never falls back to the database.
- **Out of scope (unchanged, small and bounded):** the transient staging tables `job_artifact_chunks`,
  `site_upload_parts`, `input_upload_parts` (parts live minutes, then are deleted). `chat_attachments`,
  `workflow_run_files`, `automation_files` and the input bundles of p16-zip-job-input followed in
  `p17-object-storage-rest` (§13).

## 3. Drivers

### 3.1 Local disk (`blobs/local.ts`)

`BLOB_DATA_DIR` (default `/var/lib/remyral/blobs`, compose volume `blobdata`). One file per key, directories 0700,
files 0600, written to a temporary name, fsynced and renamed, so a reader never sees half a blob. Keys are validated
against the grammar and resolved below the root (no `..`, no absolute paths, no dot segments). Upload parts live in
`.uploads/<upload id>/<n>` (no key starts with a dot) and are assembled with one streaming hash pass.

### 3.2 S3-compatible (`blobs/s3.ts`, `blobs/sigv4.ts`)

A small client over `node:https` with a **self-contained SigV4 signer** instead of the AWS SDK: the master needs
PutObject, GetObject (whole / range / stream), HeadObject, DeleteObject, CreateMultipartUpload,
CompleteMultipartUpload, AbortMultipartUpload and query-string presigning — a few hundred lines that are checked
against the worked examples of the S3 API reference (header and query authentication, five vectors) and against a real
S3-compatible server (§10). Adding `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` would be allowed by the pin
policy, but they pull dozens of transitive packages into the master image for what is one signing function; the
backup runner already carries its own SigV4 for the same reason.

- TLS verified, never configurable; `http://` only to a loopback endpoint (tests, a MinIO next to the master).
- Addressing: path-style (`endpoint/bucket/key`, R2 and MinIO) or virtual-hosted (`bucket.endpoint/key`); Amazon S3
  without an endpoint derives `https://s3.<region>.amazonaws.com`.
- A key prefix inside the bucket (`prod/`), so one bucket can serve several installations and the key's policy can be
  limited to it.
- Server-side encryption: none, SSE-S3 (`AES256`) or SSE-KMS (key id / ARN) on every write and presigned PUT.
- Errors surface the provider's `<Code>` (never its message) with a hint per code (§5).

### 3.3 Blob service (`blobs/store.ts`)

Holds both drivers; **where new blobs go** is the settings' `mode`, **where a blob is read from** is its row's
`location` (and `store_ref`), so switching modes never breaks old blobs: a bucket stays readable after a switch back
to local disk (its settings and keys are kept), a blob whose bucket is no longer the configured one answers
`store_changed` (Doctor and the download route say so). Object storage selected but unusable is an error, never a
silent fallback to local disk. Settings are cached for 30 s (other masters may change them; tests use 0).

## 4. Upload path for large outputs

### 4.1 Which files

With `execution.blobUpload` (only `blob-upload-v1` workers, only workspace jobs) the worker sends **through the blob
store**: every app package (`apk aab ipa`), every *large* type (`exe msi dmg pkg zip tar.gz tgz mp4 webm`, magic bytes
checked where the format has them; a UDIF disk image has its signature at the end) and every allowed file of at least
`thresholdBytes` (default 4 MiB, owner-configurable 64 KiB … 5 MiB). Smaller files keep the chunk path — and land in
the blob store too when the master commits them. Limits per file (default 2 GiB − 1 B, the `integer` size column) and
per job (default 5 GiB, at most 64 GiB), at most 20 such files per attempt.

### 4.2 Scan before upload

A large file is never read into memory whole. `scanLargeFile` checks the first bytes against the type and scans the
file in 1 MiB windows with an 8 KiB overlap (a secret across a boundary) with the job's pre-push scanner
(self-identifying secret patterns and the job's exact injected values); a hit drops the file ("dropped: looks like it
contains a secret"). Large text (CSV, JSON, logs) is dropped like a binary on a hit, never redacted in place (the
master cannot re-redact a 2 GB stream). Compressed archives are scanned as stored bytes; their compressed entries are
not unpacked (residual risk, §9).

### 4.3 Messages

```
w → m  BLOB_UPLOAD_REQUEST  {attemptId, epoch, requestId, artifactId, name, mediaType, sizeBytes, sha256, parts?}
m → w  BLOB_UPLOAD_GRANT    {…, status ok|refused, reason?, uploadId, target object-store|master, put | parts, expiresAt}
       (the worker PUTs: one PUT ≤ partBytes, else one PUT per part)
w → m  BLOB_UPLOAD_COMPLETE {…, uploadId, parts?: [{n, etag}]}
m → w  BLOB_UPLOAD_STATUS   {…, uploadId, status verified|failed|refused, reason?}
w → m  ARTIFACT_REF         {…, blobUploadId}            (sequenced, as before)
```

All control messages (seq 0, never in an outbox), answered only for the worker holding the job's **live lease** under
that attempt + epoch (refusals audited `denied`). The verification after COMPLETE reads the whole object, so it runs
without blocking the session's other messages.

### 4.4 The grant (`blobs/uploads.ts`)

One key (`artifacts/<job>/<attempt>/<artifact>`), one size, one SHA-256 (and per-part sizes + SHA-256 for uploads in
parts), checked against the type allowlist, the owner's per-file and per-job limits and the project's storage quota
(`reserveStorage`: may prune old files of finished jobs, else `quota`). Lifetime 15 min + 1 s per MiB (≤ 12 h).

- **Object storage:** a presigned PUT binding `content-length`, `content-type`, the SSE headers and — on providers that
  verify it (`aws`, `minio`) — `x-amz-checksum-sha256`; above `partBytes` (64 MiB) a multipart upload with one
  presigned UploadPart URL per part (`content-length` bound). The worker never sees a key, and a URL is good for one
  object only.
- **Local disk:** the master's endpoint `PUT /v1/worker/blobs/:id` (whole file) or `…/:id/:n` (part n, 8 MiB parts so
  every request stays far inside the master's 30 s request timeout and the proxy's read timeout) with a 256-bit
  one-time bearer token (only its SHA-256 is stored, cleared at verification). The endpoint streams to a temporary
  file, counts and hashes, and keeps it only for the declared size + SHA-256 (+ magic bytes); a wrong or long body fails
  the grant, a short one (interrupted) may be retried.

### 4.5 Verification and commit

COMPLETE → the master completes the multipart upload, then **reads the stored object back and hashes it** (size,
SHA-256, magic bytes) before it answers `verified` — on every provider, because a compatible server may ignore the
checksum header (SeaweedFS 3.97 does, §10); in-region (S3) and R2 reads cost no egress. Local multipart: the parts are
assembled with the same checks. Only a `verified` upload of this attempt + artifact with the claimed name, type, size
and hash can be committed by ARTIFACT_REF `blobUploadId` (idempotent; the quota is reserved again at commit).

### 4.6 Compatibility

| Master \ worker | old worker | `blob-upload-v1` worker |
| --- | --- | --- |
| old master | as before | never gets `execution.blobUpload` → chunk path; `large` types are named "not returned: large files need a master with object storage support" |
| new master | chunk path (limits as before); every committed file lands in the blob store | blob path for large outputs |

Old workers do not know the `large` types and never send them; the chunk path refuses them (`invalid`) even from a new
worker. A master selected for S3 that is unusable sends no `execution.blobUpload` (chunk path, its limits).

## 5. Settings → Integrations → Storage (`blobs/settings.ts`, `routes.ts`, web `integrations-storage.tsx`)

`GET /integrations/storage` (`integrations.storage.read`, admin): mode, bucket settings (no keys; last four characters
of the key id and a fingerprint), whether usable and why not, the limits, the last test, usage per location (blobs,
bytes), **bytes still in Postgres** (with the `blobs:migrate` command), the local directory and its free space, the
provider defaults and the least-privilege policy.

`PUT /integrations/storage` (`integrations.storage.write`, **owner**, always-fresh step-up, security-policy event
`integrations.connections`): mode, provider (`aws` / `r2` / `minio` / `other`), endpoint (https, no path / query /
credentials), region, bucket (S3 naming rules), path-style, prefix, SSE (+ KMS key id), new keys (omitted: kept) and
the limits. Choosing `s3` runs a **put / head / get / delete round trip** with the new settings first and refuses to
switch when it fails (400 `storage_test_failed` with the result: step, provider code, HTTP status, hint — nothing
changes). Keys are sealed like every integration secret (ADR-0028: AES-256-GCM under the HKDF sub-key
`ops-integrations`, AAD `object-storage`), audited by fingerprint only. `POST /integrations/storage/test`: the round
trip with the stored settings (local mode: write/read/delete in the blob directory), stored and audited.

Limits (owner): per file (1 MiB … 2 GiB − 1), per job (1 MiB … 64 GiB, ≥ per file), direct-upload threshold
(64 KiB … 5 MiB), download link lifetime (60 … 3600 s, default 300), share links at most (1 … 30 days, default 7).
**Retention per project** stays where it is: Project → Workspace → file retention (days; default keep) and the storage
quota (p5-research-workspace-next) — the sweeper now drops the blob reference and the GC deletes the bytes.

## 6. Downloads, share links, retention

### 6.1 Downloads

`GET /jobs/:id/artifacts/:artifactId/download` (`jobs.read`): object storage → **302** to a presigned GET (TTL = the
owner's download lifetime) with a forced `response-content-disposition: attachment` and
`application/octet-stream`; local disk → the file streamed with `attachment`, nosniff, a sandbox CSP and CORP
same-origin. `?open=1` ("S3'te aç") lets the browser show PDFs, images and videos in its own viewer — on the bucket's
origin, never the console's. The console's "İndir" is a plain navigation (no fetch into memory, no CORS needed on the
bucket); the job page's Dosyalar tab navigates for files above 32 MiB. The existing artifact route (previews, small
files) reads blobs through the master unchanged.

### 6.2 Share links (`blobs/shares.ts`)

`POST /jobs/:id/artifacts/:artifactId/shares {days}` (`outputs.share`, admin+ of the project; a fresh code under the
`data.access` event; at most `shareMaxDays`, at most 20 active per file): a 256-bit token, shown once
(`https://<console>/api/share/f/<token>`); only its SHA-256 is stored. `GET …/shares` lists links (never tokens),
`DELETE …/shares/:id` revokes. `GET /share/f/:token` (public, 60/min per IP): unknown → 404; revoked / expired / file
removed → 410; else the download of §6.1 (always an attachment). Create, revoke and **every opening** are audited
(`outputs.share.*`).

### 6.3 Retention and GC

Retention / quota pruning drops `content` **and** `blob_key`. The tick step `blob-gc` (every 10 min) expires upload
grants older than their lifetime + 15 min (multipart uploads aborted, local parts removed), then deletes blobs no row
references any more (pruned, deleted with their job / project, replaced, never committed) older than one hour — from
the store first, then the row (only if still unreferenced); a store error keeps the blob for the next pass. Each pass
with work is audited `blobs.gc`.

## 7. Moving existing data: `remyral-master blobs:migrate`

```
docker exec <master container> remyral-master blobs:migrate --dry-run     # counts per kind, nothing written
docker exec <master container> remyral-master blobs:migrate               # all kinds
docker exec <master container> remyral-master blobs:migrate --kind kit --kind release --batch 10
```

Per row (one row's bytes in memory at a time): read the bytea, check it against the row's SHA-256 and size, write the
blob to the **current** store, read it back and hash it, then `UPDATE … SET blob_key = …, <column> = NULL WHERE … AND
<column> IS NOT NULL AND sha256 = …` — a row changed meanwhile is skipped (its new blob is unreferenced → GC). A row
whose bytes do not match its recorded hash is **never** cleared (reported as failed). Idempotent and resumable (only
rows whose bytea is still set; keyset order); exit 0 done, 1 some rows failed, 2 could not run. Audited per kind
(`blobs.migrate`). Postgres keeps the freed pages until VACUUM: `VACUUM (FULL, ANALYZE)` of the five tables returns
~640 MB to the disk (it locks each table briefly — run it in a quiet minute). `--to-db` moves blobs back into the bytea
columns (rollback, §11; rows above the old size limits stay in the store).

## 8. Backups

- **Postgres** (pg_dump, WAL): the metadata — rows, keys, hashes, settings (sealed keys), upload grants, share links.
  After `blobs:migrate` the dumps shrink by ~640 MB.
- **Local blob directory** (`blobdata` volume, mounted read-only into the backup service as `/blobs`): mirrored
  incrementally by the runner (`infra/backup/runner/lib/blobs.mjs`) — every new blob encrypted to the owner's age keys
  into `<backups>/blobs/data/<key>.age` and, with an off-site target, uploaded to `<prefix>/blobs/<env>/<key>.age`.
  Blobs are immutable, so a file is copied once. A blob the master deleted stays in the mirror for
  `BACKUP_BLOB_KEEP_DELETED_DAYS` (default 35; an older dump may still name it), then goes. The run's `blobs` summary
  is in status.json; a failed copy makes the run `partial`.
- **Object storage:** the bucket is the system of record for those blobs and is **not** copied by the runner.
  Recommended: bucket versioning on, a lifecycle rule that expires non-current versions after 35 days and aborts
  incomplete multipart uploads after 1 day, and (S3) Object Lock / R2 bucket lock if the owner wants deletion
  protection. The master never deletes a bucket or lists it.
- **Restore drill:** restore the dump as before; local blobs: decrypt `<backups>/blobs/data/**.age` with the owner's
  age key into the new `blobdata` volume at the same relative paths (`age -d -i key.txt -o <blobs>/<key> <key>.age`),
  owned by uid 10001, 0600; Doctor's `storage` check and a download of a recent output confirm it. Object storage: the
  restored master reads the same bucket (settings and sealed keys are in the dump; the master key file must be the
  same). Rows whose blob is gone (older dump, expired mirror copy) answer 410 `file_missing` — the job page shows the
  file as removed. Documented in [docs/ops/backup-restore.md](../ops/backup-restore.md) §12.

## 9. Security review

| Threat | Control | Test |
| --- | --- | --- |
| Storage keys leaking to workers, logs, the console, the chat | Keys sealed (ADR-0028 scheme, AAD `object-storage`), never returned (hint + fingerprint only), audited by fingerprint; workers get only presigned URLs / one-time tokens; the assistant has no tool for them | integration: secret not in responses, row, audit; worker uploader drops an `authorization` header toward object storage |
| A worker writing elsewhere / more than granted | The grant names one key; presigned URLs bind method, key, `content-length` (+ checksum, SSE); local tokens are bound to one upload row and expire; parts are bound to their declared size + hash | unit: wrong body / longer body / other key refused by the signature-checking fake; integration: parts upload |
| A worker lying about the content | The master reads every object back and hashes it (size, SHA-256, magic bytes) before `verified`; only verified uploads commit | integration + interop (SeaweedFS stores a tampered body; the read-back catches it) |
| A stale attempt uploading after its lease | Every BLOB_UPLOAD_* is fenced by the live lease (attempt + epoch); refusals audited | session handler (same SQL as the other leased control messages) |
| Secrets inside large outputs | Windowed scan with overlap on the worker (patterns + the job's exact values); hit → dropped. **Residual:** compressed archive entries are not unpacked; the master does not re-scan blob uploads | unit (secret across a window boundary) |
| Malicious content served on the console origin | Blobs are attachments on the console (nosniff, sandbox CSP, CORP); presigned GETs force `attachment` + `application/octet-stream`; `open=1` only for PDF / images / video and only on the bucket's origin; no HTML / SVG / scripts are allowed types | integration: headers, 302 target |
| Presigned links forwarded / replayed | Lifetime 60 … 3600 s (default 300); every link is minted after `jobs.read` on that job; no link is stored | integration |
| Share links | 256-bit token, stored hashed, ≤ 30 days (owner bound), revocable, at most 20 per file, rate-limited, every opening audited, a removed file or revoked link → 410, owners / admins only + a fresh code under the `data.access` event | integration: create / open / revoke / 410 / 404, audit order |
| Bucket exposure | Private bucket, no public ACL / policy, no listing permission needed; CORS not needed (downloads are navigations, uploads come from workers / the master, not browsers); least-privilege policy shown in the panel and the guide (object put / get / delete + multipart under the prefix) | unit: policy text |
| Path traversal in the blob directory | Key grammar + resolution below the root; part directories under `.uploads/<uuid>` | unit |
| SSRF through the endpoint | Owner-only, always-fresh step-up, https (http only to loopback), no path / query / credentials; the round trip runs before anything is saved | unit (validation), integration |
| Key rotation | Enter new keys (the old ones keep working until replaced); a test runs before the switch; keys never leave the master; recommended: rotate at least yearly, delete the old key at the provider after the save | guide |
| Losing blobs on a store switch | Each blob keeps its location; the bucket client stays while its settings exist; Doctor flags unusable / unreachable storage | integration (S3 blob readable after switching back) |
| Flooding the master's endpoint | Device route (one-time token), 600/min per IP, request timeout per part; upload grants bounded per attempt / job / project quota | route coverage |

## 10. Tests

- `apps/master/test/unit/blobs-sigv4.test.ts` — the five SigV4 examples of the S3 API reference.
- `apps/master/test/unit/blobs-s3.test.ts` — the client against a **signature-checking S3 fake**
  (`test/helpers/fake-s3.ts`, an independent canonicalisation): put / head / get / range / stream / delete, wrong
  secret, presigned PUT (wrong / longer body, another key), multipart, presigned GET headers, endpoint rules; settings
  validation, limits, policy; the local store (modes 0600 / 0700, key grammar, streamed writes, parts, assembly).
- `apps/master/test/unit/blobs-s3-interop.test.ts` — the master's signer and the worker's uploader against a **real**
  S3-compatible server (skipped unless `REMYRAL_S3_INTEROP_URL`): run against SeaweedFS 3.97 in a throw-away container
  (MinIO images are no longer published anonymously): header auth, presigned PUT / GET, multipart through the worker
  uploader — all passed; SeaweedFS ignores `x-amz-checksum-sha256` (the reason for §4.5's read-back).
- `apps/master/test/integration/object-storage.test.ts` — real master + real worker daemon: settings (admin read,
  owner write, stale code refused, failed round trip changes nothing, keys never shown, audit), local disk with a
  9 MiB output in parts + an installer + small files (all rows blob-backed, 0600 files, downloads, audit), object
  storage (presigned PUTs, 302, `open=1`, share links create / open / revoke / 410 / 404 + audit order, readable after
  switching back), an older worker (chunk path, `large` types named), retention → GC, `blobs:migrate` (dry run, move,
  corrupt row kept, resume, `--to-db`).
- `apps/worker/test/blob-upload.test.ts` — collection limits, older-master behaviour, the windowed scan (secret across a
  boundary), hashing in parts, the upload sequence (single / parts / refusals / not verified), the HTTP uploader
  (ranges, master-origin paths only, no authorization toward object storage, loopback-only http).
- `packages/protocol/test/blob-uploads.test.ts`, fixtures for the four messages; `apps/web/test/object-storage.test.tsx`;
  `scripts/test/backup-blobs.test.mjs`; route coverage, OpenAPI, RBAC matrix, step-up list updated.

## 11. Rollback

Forward-only migration; an older master ignores the new tables and columns **but cannot read rows whose bytes moved to
the store**. Before rolling the master back: `remyral-master blobs:migrate --to-db` (moves blobs back into the bytea
columns where the old constraints allow — rows above 5 MiB (80 MiB packages) and the new large types stay in the store
and are unreadable for the old master), then deploy the older images. Workers: a `blob-upload-v1` worker under an older
master keeps the chunk path by construction (§4.6). Turning object storage off: switch to local disk in the panel
(blobs already in the bucket stay readable while its settings are kept).

## 12. Not done / follow-ups

- ~~`chat_attachments`, `workflow_run_files`, `automation_files`, input bundles (p16-zip-job-input) still use bytea~~ —
  done in `p17-object-storage-rest` (§13).
- Large uploads from the **browser** (job inputs, site uploads, chat attachments, input bundles) still go through the
  master; **presigned browser uploads are deferred** (§13.5): they need CORS on the owner's bucket — an owner decision,
  backlog `p17-presigned-browser-uploads`.
- No master-side scan of blob uploads (the worker scans; the master verifies integrity and type only).
- ~~Moving blobs **between** stores (local → bucket) is not a command yet~~ — `blobs:migrate --to-store` (§13.3).

**UNVERIFIED (needs the real providers / deployment):** Cloudflare R2 and AWS S3 themselves (the signer passed AWS's
documented vectors and a real S3-compatible server, not the two services); `x-amz-checksum-sha256` on R2 (not sent
there; the read-back verifies anyway); a 2 GB upload end to end on the production network; Traefik v3's default
`readTimeout` (60 s) with 8 MiB parts from a slow uplink; the backup mirror on the production volume (`age` binary in
the backup image, DAC_READ_SEARCH over the 0600 blob files); macOS / Windows workers (the uploader is plain Node
`fs` + `http(s)`, tested on macOS only).

## 13. p17-object-storage-rest — the remaining blobs, moving between stores (2026-10-25)

- **Task:** `p17-object-storage-rest`. **Migration:** 0157 (`blob_key` on four more tables, nullable bytea, four more
  key prefixes / kinds, `blob_objects.prior_location` + `prior_store_ref`). Additive; no protocol change.
- **Release:** master only. After the deploy: `remyral-master blobs:migrate --dry-run`, then `blobs:migrate` (the four
  new kinds are part of "all kinds"); `--to-store` when the owner wants the blobs in the bucket.

### 13.1 What moved where

| Table | Kind / key | Writer (new rows: bytes only in the store) | Readers (bytea **or** blob) | Deleted with |
| --- | --- | --- | --- | --- |
| `chat_attachments` | `chat-attachment` · `chat-attachments/<thread>/<id>` | upload (`ChatAttachments.upload`) | content route, text context of a turn, worker pull (`slice` → range read), chat files as job inputs, search snippets and the chat knowledge index | thread delete (cascade), unsent sweep (24 h), attachment remove |
| `workflow_run_files` | `workflow-file` · `workflow-files/<run>/<input>` | run creation (`insertRunFiles`, v1 + v2 engines) | step job inputs (`runFileInputs`) | workspace retention (prune: `content` **and** `blob_key` NULL, `pruned_at` set), run / project delete (cascade) |
| `automation_files` | `automation-file` · `automation-files/<automation>/<input>` | `replaceAutomationFiles` (create / update) | run inputs (`automationFileInputs`) | file replaced on update, **automation delete** (new: the soft-deleted automation drops its files) |
| `input_upload_files` | `input-bundle` · `input-uploads/<upload>/<idx>` | bundle completion (`InputUploadService.complete`) | the worker relay (`slice` → range read of `chunkBytes`) | bundle delete, retention sweep (14 days / 20 per project), project delete |

Every reader first runs the same authorised row query as before (thread owner or a reader of a shared conversation;
project grants; the job's live lease for the relay) and only then reads the bytes by the row's key — a key is never
taken from a request, so the store adds no new path to another user's or workspace's file (integration test: another
user gets 404 for an attachment, a bundle cannot be named from another project). Integrity: every write records size +
SHA-256 in `blob_objects` (the row keeps its own SHA-256); `blobs:migrate` checks the bytea against the row hash and
reads the blob back before it clears the bytea. Audit: unchanged per feature (`chat.attachment.upload`,
`input.upload.*`, `automation.*` — the automation delete records the number of dropped files), plus `blobs.gc` and
`blobs.migrate` as for job artifacts.

**Deletion = the artifact path.** Deleting or pruning the owning row only drops the reference; the blob GC (tick step
`blob-gc`, every 10 min, §6.3) deletes every blob no table references — `BLOB_REFERENCES` in `blobs/store.ts` now names
all nine tables, so the GC never deletes a blob a chat / run / automation / bundle still uses and never leaves one
behind (tests: thread delete, run-file retention, automation delete, bundle delete → file gone from the disk after the
grace period). Writes that are refused or rolled back after the bytes were put (thread full, bundle refused) leave an
unreferenced blob the GC removes, exactly like an uncommitted job output.

### 13.2 `blobs:migrate` for the four tables

`--kind chat-attachment|workflow-file|automation-file|input-bundle` (all of them by default): bytea → current store
with the same keys the writers use, the same verification (row SHA-256 + size, read-back), keyset order, batches,
`--limit`, `--dry-run` (rows + bytes per kind), idempotent and resumable, a corrupt row is reported and keeps its bytes.
`--to-db` moves them back (the old bytea size checks still hold, so every row fits). Settings → Storage's "bytes still
in Postgres" counts the four tables too.

### 13.3 `blobs:migrate --to-store local|s3` — between stores

```
docker exec <master> remyral-master blobs:migrate --to-store s3 --dry-run     # blobs + bytes per kind not yet in the bucket
docker exec <master> remyral-master blobs:migrate --to-store s3               # local disk → the configured bucket
docker exec <master> remyral-master blobs:migrate --to-store local --kind artifact --batch 50
```

Per blob (`blobs/move.ts`), keyset over `blob_objects.key`, only verified blobs without an open upload grant:

1. **copy** — stream the blob from where its row says it lives into the destination under the same key (streamed:
   blobs reach 2 GiB; S3 gets a signed PUT with an unsigned payload and an explicit length);
2. **verify** — read the destination copy back and hash it; size and SHA-256 must match the row;
3. **switch** — one `UPDATE blob_objects SET location, store_ref, prior_location = location, prior_store_ref =
   store_ref` guarded by the old location, store ref and SHA-256 (a blob replaced or deleted meanwhile is skipped);
4. **delete** the old copy, then clear `prior_*`.

A run cut short loses nothing: before 3 the row still names the intact old copy (the next run copies again over the
partial copy); after 3 it names a verified copy, and the next run deletes the old copy first (`leftoversDeleted`) — the
blob GC does too if the blob itself goes. The old copy is never deleted while it is the live one (`sameStore` guard).
Exit 1 when a blob failed or an old copy could not be deleted yet. The direction does not change the mode: switch
Settings → Storage too, or new blobs keep going to the old store (the command says so). `--to-store s3` needs a usable
bucket in the settings (the bucket client is kept in local mode, so local → bucket works before the switch); a blob in
a bucket that is no longer the configured one cannot be read and is reported as failed. `--to-store` and `--to-db`
exclude each other. Audited per kind (`blobs.migrate`, direction `to-store:<location>`).

### 13.4 Security

| Threat | Control | Test |
| --- | --- | --- |
| Reading another user's / workspace's file through the store | Reads resolve the row through the unchanged authorised query first and use only that row's key; keys are server-built from ids | integration: other user 404, foreign project cannot name a bundle |
| A blob deleted while still in use | One reference list (`BLOB_REFERENCES`) for the GC's select and its guarded delete; grace period 1 h | integration (four tables), unit (every new table listed) |
| Orphaned bytes after deletes | Deleting / pruning drops the reference; GC deletes the bytes (also an interrupted move's old copy) | integration: files gone from the disk |
| Data loss during a store move | Copy → read-back verify → guarded switch → delete; `prior_*` makes the delete resumable; never deletes the live copy | integration: failed PUT midway, failed delete, resume, back to local |
| Corrupt legacy bytes copied as if good | Row SHA-256 + size checked before the write, read-back after; mismatch → row kept, reported | integration |
| Path traversal through the new prefixes | Same key grammar (DB CHECK + `BLOB_KEY`) and below-root resolution | unit |

### 13.5 Not done

- **Presigned browser uploads** (chat attachments, bundles, job inputs, site uploads straight from the browser to the
  bucket): deferred. They need a CORS rule on the owner's bucket (allowed origin = the console, PUT, the bound
  headers) — a configuration the owner must decide on and maintain at the provider; downloads and worker uploads need
  none. Backlog `p17-presigned-browser-uploads` (owner decision first).
- The transient staging tables (`job_artifact_chunks`, `site_upload_parts`, `input_upload_parts`) stay in Postgres.

**UNVERIFIED:** `--to-store` against R2 / AWS S3 themselves and with multi-GB blobs on the production network (tested
with the signature-checking S3 fake and the local disk); the size of a real migration of prod's chat attachments.
