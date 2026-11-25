# Design note: `p17-output-limits` — job output limits that bytes decide, with a zip instead of silent skips

- **Task:** `p17-output-limits`. **Date:** 2026-10-27. **Migration:** `0172_output_limits.sql`.
- **Owner direction (2026-10-27):** "bu sınır mantıklı değil: İş başına en fazla 20 çıktı dosyası"; then "500 uygun,
  üstü olursa zip seçeneği ile devam edilebilir".
- **ADR:** [ADR-0064 amendment 2026-10-27](../adr/0064-object-storage-for-blobs.md#amendment-2026-10-27-output-limits-decided-by-bytes-overflow-zip-p17-output-limits).
- **Builds on:** [p17-object-storage](p17-object-storage.md) (blob store, `blob-upload-v1`),
  [p17-panel-settings](p17-panel-settings.md) (server settings with an environment default),
  [p5-research-workspace(-next)](p5-research-workspace.md) (workspace jobs, storage quota).

## 1. Before

`MAX_ARTIFACTS = 20` (protocol `workspace.ts`) dated from the time outputs lived in Postgres: at most 20 inline files
(5 MiB each, 15 MiB per job, chunks staged in `job_artifact_chunks`), and `BLOB_LIMITS.maxFiles = 20` for files that
went to the blob store. The worker skipped file 21 and later into the summary's "Not returned" list — nowhere else; the
job page and the chat card said nothing. The prod master has the blob store, so 20 was no longer a storage limit.

## 2. The limits now

| Setting | Default | Ceiling | Where to change |
| --- | --- | --- | --- |
| Output files per job (inline + storage together; the zip counts as one; `summary.md` not counted) | 500 | 2000 | Ayarlar → Sunucu ayarları → İşler, panel key `jobs.outputMaxFiles` (environment `JOB_OUTPUT_MAX_FILES` is the default); a workspace project may set a **lower** value in Proje → Depo → Depolama (`project_workspaces.output_max_files`, 1–2000; the effective value is the smaller one) |
| Inline (direct) bytes per file | 5 MiB | fixed | protocol `OUTPUT_LIMITS.inlineFileBytes` (= `MAX_ARTIFACT_BYTES`) |
| Inline bytes per attempt (Postgres staging budget) | 15 MiB | fixed | protocol `OUTPUT_LIMITS.inlineTotalBytes` (= `MAX_ARTIFACTS_TOTAL_BYTES`) |
| Blob store: bytes per file | 2 GiB − 1 B | 2 GiB − 1 B | Ayarlar → Entegrasyonlar → Depolama (unchanged) |
| Blob store: bytes per job | 5 GiB | 64 GiB | Ayarlar → Entegrasyonlar → Depolama (server); a workspace project may set a **lower** value (`project_workspaces.output_max_job_bytes`, 1 MiB–64 GiB) |
| Blob threshold (at or above: always the store) | 4 MiB | 5 MiB | Ayarlar → Entegrasyonlar → Depolama (unchanged) |
| Project storage quota | none | 1 TiB | Proje → Depolama (unchanged; always applies, inline and blob) |
| Overflow zip | 1 per attempt, ≤ 10 000 entries, ≤ min(2 GiB − 1 B, blob per-file limit, per-job bytes left) | fixed | protocol `OUTPUT_LIMITS.zip*` |
| One file inside the overflow zip | 64 MiB | fixed | protocol `OUTPUT_LIMITS.zipEntryMaxBytes` |
| Entries of `out/` looked at | 20 000 | fixed | protocol `OUTPUT_LIMITS.walkMaxEntries` |
| Older workers (without `output-limits-v1`) | 20 inline + 20 blob files, no zip | — | (legacy, enforced by the master for them) |

The 15 MiB inline budget stays: inline chunks are staged in Postgres rows until the commit, and the budget keeps that
bounded per attempt whatever the file count is. Everything that does not fit goes to the blob store, so raising it buys
nothing once a store is there.

## 3. Bytes decide the path (worker, `collectArtifacts` with `execution.outputLimits`)

For every allowlisted file of `out/` (walk order: per directory by name, depth ≤ 4, symlinks never followed):

1. The count: at most `maxFiles` files are returned in place; when there are more allowlisted files than that and a zip
   is possible, `maxFiles − 1` stay in place and the zip takes the last slot.
2. Download-only types (packages, installers, archives, videos) and files at or above the blob threshold go to the blob
   store, as before.
3. Every other file is returned inline while it fits the inline budget (5 MiB each, 15 MiB per attempt); a file that
   does not fit goes to the blob store **automatically** (any allowed type; text then follows the blob rule: scanned and
   dropped on a secret hit instead of redacted in place, as for large text since p17-object-storage).
4. A blob file over the per-file limit is not returned (`too_large`); one beyond the per-job bytes goes to the overflow.
5. **Without a blob store for the job** (object storage selected but not usable — `BlobUploads.assignment()` returns
   null — or a worker without `blob-upload-v1`): inline only. The count is still the job's limit (500), the inline
   budget decides; large types and files that do not fit are named with `inline_budget` / `too_large`. The settings
   screens say so (Sunucu ayarları → İşler, Proje → Depolama).

## 4. Above the limit → `out-rest.zip`

Decision: the worker zips **the remaining files**, not all of `out/` — the files that fit stay individually
downloadable and previewable; only the overflow is packed.

- **What goes in:** the allowlisted files beyond the count, and the files that did not fit the per-job blob bytes
  unpacked (compression may make them fit). Paths are kept (`data/r0491.csv`). Name `out-rest.zip`, or
  `out-rest-2.zip`, … when the agent wrote that name itself.
- **Where:** written by the worker to a private `mkdtemp` directory outside `out/` (0600, created with `wx`), uploaded
  through the blob path like any large output (grant, PUT, the master's own size + SHA-256 + magic check, ARTIFACT_REF
  `blobUploadId`), then removed. It needs the blob store: without one there is no zip.
- **Rules for zipped content** (the same as inline outputs): only allowlisted types and names (a disallowed file is
  skipped with `type`, never zipped); each entry is read with `O_NOFOLLOW` from the walk's own listing (a symlink is
  never followed — skipped with `symlink`; a file swapped for a symlink after the listing fails the read); content must
  match the type (magic bytes / UTF-8); text up to 5 MiB is redacted with the job redactor (injected values +
  patterns), larger text and binaries are scanned in overlapping windows and dropped on a hit (`secret`). The zip as a
  whole is not scanned again (its entries were, before compression); the master checks its size, SHA-256 and `PK`
  magic like every blob upload. Already-compressed types are stored, the rest deflated.
- **Bounds, then skip with a reason:** ≤ 64 MiB per entry (`too_large`), ≤ 10 000 entries and ≤ min(2 GiB − 1 B, blob
  per-file limit, per-job bytes left) for the archive (`zip_full`); no ZIP64. A zip whose upload fails turns every file
  in it into `upload`.
- **The agent is told:** the preamble names the limit, the direct / storage budgets, that extra files are zipped
  automatically into `out-rest.zip` with their paths, and that it may deliver one `.zip` of its own instead of many small
  files (without storage: that files beyond the limit are not returned).

## 5. Nothing silent

- **JOB_RESULT `outputs`** (protocol `OutputReport`, additive, `output-limits-v1` workers): `maxFiles`, `returned`,
  `storage`, `zip {name, files, bytes}`, the first 100 skipped files `{name, code, reason}` and the exact
  `skippedCount`. Codes: `type`, `too_large`, `count`, `inline_budget`, `job_bytes`, `secret`, `content`, `symlink`,
  `not_regular`, `nested`, `unreadable`, `upload`, `zip_full`, `not_listed`, `other`. Stored with the run in
  `job_runs.result` (no new table).
- **The master's own refusals** (an ARTIFACT_REF rejected for `limit`, `quota`, `invalid`, `incomplete`) are already
  journaled in `worker_inbox`; `GET /jobs/:id/output-report` adds them (codes `count`, `quota`, `content`, `upload`) to
  the worker's report for the latest attempt and subtracts them from `returned`.
- **Console:** Dosyalar tab — "N dosya zip olarak paketlendi (out-rest.zip)" and "N dosya alınmadı: <sebep>" per
  reason with the names under "Hangi dosyalar?", "R / M dosya döndü", the no-storage line; the chat's job card — one
  line each (one reason: "N dosya alınmadı: <sebep>", several: "N dosya alınmadı"). `summary.md` also lists the zipped
  files ("## Packed into out-rest.zip"). tr + en.

## 6. Downloads

- `GET /jobs/:id/artifacts` is paged: `limit` (≤ 1000, default 500 — an older console asking without a query gets the
  first 500, was 200), `offset`, and `total`; order: newest attempt first, its summary first, then by name.
- The Dosyalar tab loads 500, then "Daha fazla göster (N kaldı)"; above 20 outputs the files are grouped by their top
  folder (folded `<details>`, top-level files and the summary flat).
- **p18-outputs-delivery (2026-10-28):** the archive now unpacks the overflow zip in place ("Tüm dosyaları indir
  (zip)"), names removed files in `_removed-files.txt`, the tab pages for real (`q` filter, URL state) and the zipped
  delivery is said everywhere — see [p18-outputs-delivery](p18-outputs-delivery.md). The text below is the p17 state.
- **"Hepsini indir (zip)"** — `GET /jobs/:id/artifacts/all.zip` (`jobs.read` on the job, exactly like the files): the
  latest attempt's stored outputs and its summary (as `_summary.md`, duplicate names numbered), pruned files left out,
  **streamed** from the store (stored entries with data descriptors, CRC-32 computed while streaming, sizes from the
  rows checked; a blob of another size ends the stream instead of writing a corrupt entry). Bounded to 2100 entries and
  4 GiB (no ZIP64) — beyond: 413 `archive_too_large`. `nosniff`, `no-store`, attachment.

## 7. Master bounds (against the attempt's record)

`job_attempts.output_max_files` / `output_max_job_bytes` are written when the attempt is assigned (orchestrator →
`OutputLimitsService.assignment`), so a settings change never moves a running attempt's bounds:

- `stageChunk`: the staging budget counts **inline** bytes only (rows backed by a blob upload are left out — fixes a
  latent p17-object-storage issue where > ~180 MiB of blob outputs would have refused the summary's chunks); the
  artifact count stops at `maxFiles + 2` (legacy: 20 + 20 + 2).
- `commitArtifact` (inline): with a record, every output of the attempt (inline, committed blob, granted upload) counts
  against `maxFiles`; inline bytes ≤ 15 MiB as before (blob rows left out); legacy: ≤ 20 inline.
- `BlobUploads.grant`: per-job bytes = min(store limit now, the attempt's recorded bytes); with a record the count is
  blob + inline outputs ≤ `maxFiles`, else the legacy 20.
- The project storage quota applies to every commit (unchanged).

## 8. Protocol, flag, deploy order

- Feature **`output-limits-v1`** (worker → master). The master sends `execution.outputLimits {maxFiles, zipOverflow}`
  and a `blobUpload.maxFiles` above 20 only to workers that advertise it (an older worker's schema stops at 20 — it
  would refuse the assignment). `zipOverflow` is true only with `blobUpload`.
- **Older workers** keep 20 inline + 20 blob files and their skip list in `summary.md`; the master records nothing for
  their attempts and enforces the legacy bounds; the console shows no report (nothing to show).
- **Older masters** never send `outputLimits`: a new worker keeps the legacy path (no zip, 20 + 20).
- **Deploy order:** master first (migration 0172, the setting, the routes), then the worker release. Nothing needs both
  at once.
- **Rollback:** an older master ignores the columns (the legacy limits apply again) and the `outputs` field; outputs
  already stored stay readable (they are ordinary artifacts, the zip a blob). To remove the columns: see the migration's
  header.

## 9. Security review

- No new trust: the limits come from the master (owner setting, project override bounded by the server value and the
  protocol ceiling); a worker cannot raise them — the master re-checks counts and bytes against its own record.
- The zip cannot be used to smuggle what single files cannot: same type allowlist, same redaction / secret scan,
  symlinks never followed (walk by `lstat` dirents, reads with `O_NOFOLLOW`), written outside `out/` where the agent
  (already finished) cannot swap it, and uploaded through the verified blob path. It is `application/zip` — download
  only, never previewed, never an input (unchanged rules for `.zip`).
- "Hepsini indir": same authz as each file (`jobs.read` resolved from the job), same headers as attachments, a bounded
  stream; names come from the rows (validated `ArtifactName`s).
- Postgres stays bounded: inline staging ≤ 15 MiB + allowances per attempt, artifact rows ≤ 2000 + 2 per attempt.
- Residual: compressed entries of an agent's own zip are still not unpacked for the scan (as in ADR-0064); the zip's
  text entries above 5 MiB are dropped on a hit rather than redacted.

## 10. Tests

- Protocol: `packages/protocol/test/output-limits.test.ts` (feature, ASSIGN_JOB / JOB_RESULT shapes, bounds, the
  effective limit).
- Worker: `apps/worker/test/output-limits.test.ts` (count over inline + blob, the zip with paths and redaction, the
  numbered name, symlink refusal and a dropped secret, the per-job byte bound → `zip_full`, the entry bound, bytes decide
  the path, no blob store, 500 small files, the legacy path with the flag off, the zip writer's bounds, report / summary /
  preamble).
- Master: `apps/master/test/integration/output-limits.test.ts` (panel setting with the environment default and the
  ceiling, the project override and its audit, 505 files → 10 inline + 489 blob + `out-rest.zip` with 6 files through a
  real worker daemon, the attempt record, the report, the paged list, the zip's paths, download all + authz, an older
  worker, staging / commit bounds and the inline-only staging budget); `apps/master/test/unit/workspace-archive.test.ts`
  (the streamed archive).
- Web: `apps/web/test/output-limits.test.tsx` (the setting and the storage notice, the notices, 601 files in folders
  and pages, download all, the card's lines), `diyalog-w3-project-rest.test.tsx` (the project override).

## 11. Not done / unverified

- Not run against a real S3 / R2 bucket in this change (the blob path itself is p17-object-storage's, tested there with
  the signature-checking fake); the 500-file run used the master's local-disk store.
- Repository projects' repository-less workflow steps (`repo-scratch-v1`) use the server value (no project override:
  the override lives with the workspace storage policy).
- Worker OS coverage: the zip writer and the walk are plain Node file APIs; run on darwin-arm64 here, Windows / Linux
  unverified until the release CI.
