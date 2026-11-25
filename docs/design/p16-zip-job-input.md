# p16-zip-job-input — drop a .zip and say "bu dosyalarla şunu yap"

- **Task:** `p16-zip-job-input`. **Date:** 2026-10-23. **Decision:** [ADR-0060](../adr/0060-job-input-files-from-archives.md).
- **Owner need:** drop a .zip into the Sohbet (or the job composer) and say what to do with its files — the files are
  the job's input in its working directory. Before: a chat .zip could only be published as a site
  ([p15-chat-zip](p15-chat-zip.md), §5 sketched this feature); job inputs were ≤ 10 files / 10 MiB, workspace only.
- **Builds on:** [p10-site-upload](p10-site-upload.md) (browser zip reader, chunked upload, ADR-0037),
  [p15-chat-zip](p15-chat-zip.md) (composer chips, message facts, fenced context),
  [p15-workspace-retention](p15-workspace-retention.md) (a seed pulled before the run, relay fenced by the lease),
  [p5-research-workspace](p5-research-workspace.md) (`in/`, JOB_INPUT_REQUEST).
- **Migration:** 0145 (0144 = p16-webhooks-out). **Prompt rule:** 44 (43 = p16-webhooks-out).
- **Worker release:** yes (`input-bundle-v1`: pulls the bundle; the assistant tool and rule 44 are compiled into the
  worker). Old workers are excluded by placement (`input_bundle_unsupported`).
- **Live status:** UNVERIFIED-LIVE on real hosts (see §8).

## 1. Flow

```
 browser (Sohbet composer, both consoles' shared tray — or the job composer's "Files from a .zip")
   .zip ─► readZip(file, INPUT_ZIP_LIMITS): ≤ 128 MB archive, ≤ 100 MiB inflated, ≤ 25 MiB per entry, CRC, no
            symlink / ZIP64 / encryption; .git/, node_modules/, __MACOSX/ entries skipped UNREAD (counted)
       ─► planSite (as before) + planInputBundle: NFC names, litter left out, the one shared top folder stripped,
            path rule / collisions / size refused one by one (@remyral/protocol/input-bundle-files)
   chip: name · N files · size · mode  [Mesaja göre | Site (yayınla) | İş girdisi]  · project · refused / left out
         a site that can also be input → "Mesaja göre" (both); anything else that fits → "İş girdisi"; neither → note
   Send:
     site  ─► site upload (unchanged)                                            ┐ both when "Mesaja göre"
     input ─► POST /projects/:p/input-uploads {files:[path,size,sha256]}          │
              → PUT parts (≤ 4 MiB, SHA-256, retried, resumed)                    │
              → POST …/complete {allowSecrets?}                                   ┘
                  422 input_secrets_found {findings:[path, rule, line]} → chip "Yine de gönder" → next Send completes
                  the SAME upload with allowSecrets (audited); 422 input_refused (e.g. an ELF) → "Reddedilenleri çıkar"
   POST /chat/threads/:id/messages {text, siteUploads?, archives?, inputUploads?: [uploadId]}
                                     ▼
 master: each bundle the sender's own, ready, in a project they may create jobs in (else 404) → linked to the message,
   meta.inputUploads (id, project, label, counts, first 25 paths, findings sent anyway), fenced block "input bundle of
   this message", history note "[input bundle: x.zip (N files, project p, uploadId …)]"
 assistant (rule 44): draft_job {…, inputUpload} in the bundle's project (master: readable, ready, same project; again
   at confirm) → job created → job_input_uploads row (facts kept after pruning)
 placement: only input-bundle-v1 workers (permanent reason otherwise)
 ASSIGN_JOB execution.inputBundle {uploadId, files, totalBytes, bundleSha256}
 worker: INPUT_BUNDLE_REQUEST list (pages of 500) → check count / total / bundleSha256 / paths / collisions
         INPUT_BUNDLE_REQUEST read (192 KiB slices, 4 files at a time) → size + SHA-256 per file → wx, 0444
         workspace job: <scratch>/in/        repository job: <root>/sandboxes/<job>/<attempt>/in (next to the checkout)
         preamble "[Remyral input files] …" + a timeline note; a failed pull fails the attempt before the agent
```

## 2. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Where is the .zip unpacked? | In the browser (the site reader with larger caps) | ADR-0037: no archive parser on the control plane |
| Storage | Postgres like site uploads: parts while receiving, then one row per file (`content` with `STORAGE EXTERNAL`) | Same operational model and backups as site uploads; `EXTERNAL` lets the relay's `substring()` read only a slice |
| Complete in one request? | Streamed part by part inside one transaction (≤ 25 MiB + one part in memory) | 100 MiB `Buffer.concat` on the master would be avoidable memory pressure |
| File types | Everything except native executables (magic bytes + extension), policy override `inputs.executables` | ADR-0060 §2 |
| Secrets | Text files scanned (`scanText`, no entropy heuristic); findings block; uploader's "send anyway" completes the same upload, audited | ADR-0060 §3 |
| Caps | 2000 files / 25 MiB / 100 MiB, 128 MB archive, 2 receiving per person, 20 ready per project | ADR-0060 §4 |
| Transport to the worker | New control job messages `INPUT_BUNDLE_REQUEST` / `INPUT_BUNDLE_DATA`, live-lease checked, first page and refusals audited (`job.input_bundle.read`) | The JOB_INPUT_REQUEST pattern; no new trust in the master (hash chain from the signed assignment) |
| Repository jobs | Scratch `in/` in the attempt's sandbox dir, read-only container mount at the same path | Never committed; readable by every profile (Seatbelt allows the sandbox dir, Windows per-job ACL covers it) |
| Failure | A failed pull fails the attempt before the agent starts | The user asked for these files; a run without them would produce something else |
| A site .zip | "Mesaja göre" = uploaded both ways; the user's words decide; ambiguous → `ask_user` | Owner brief: keep both options; one upload of each is cheap (≤ 50 MiB for a site) |
| Schedules | Not allowed (composer validation) | A bundle may be pruned before a scheduled run |
| Reuse | `run_again` and the composer's `?from=` carry the bundle while it is kept; the assistant may name the same id | "follow-up jobs can reuse it" |
| Retention | 14 days after the last use (creation or pull), never while an unfinished job names it, 20 per project | Like kept working files (p15-workspace-retention) |

## 3. Master

- `apps/master/src/input-uploads/` — `checks.ts` (manifest + content checks, refusal / finding text), `service.ts`
  (start, parts, streamed complete with the secret override, get / list / remove, chat resolve / bind, `forNewJob`,
  `forJob`, `assignment`, `hasBundle`, `slice`, sweep; `attachInputUpload` for the jobs store), `routes.ts`.
- `jobs/store.ts` `CreateJobInput.inputUpload` → `job_input_uploads` in the creation transaction (audited in
  `job.create`), `orchestration/routes.ts` `POST /jobs inputUpload`, `orchestration/orchestrator.ts` placement fact +
  `execution.inputBundle`, `orchestration/session.ts` the relay.
- Chat: `chat/input-uploads.ts` (facts, fenced block, notes, `list_input_bundle_files`, `draft_job` check),
  `chat/service.ts` (send / edit carry `inputUploads`), `chat/tools.ts`, `chat/drafts.ts` (re-check at confirm),
  `chat/job-actions.ts` (run again reuses the bundle).
- Security policy: section `inputs.executables` (model, `change_settings`, `get_settings`).
- Audit: `input.upload.start|complete|secrets_override|delete|prune`, `job.input_bundle.read`, `job.create` metadata.

## 4. Worker

`apps/worker/src/workspace/input-bundle.ts` (`listBundle`, `pullInputBundle`, `inputBundlePreamble`), runner phase
`input-bundle` (scratch: after the inputs, before kept-file seeds — the user's files win; repository: after the git
view, before the confiner so the container mount can name the dir), daemon channel `inputBundles.request`, feature
`input-bundle-v1`.

## 5. Console

`lib/inputBundle.ts` (plan, leave out, upload with the override), `lib/siteUpload.ts` `uploadChunked` (shared by site
uploads and bundles), `lib/siteZip.ts` (`INPUT_ZIP_LIMITS`, `skipDirs`), `screens/chat/useSiteZips.ts` + `ZipAttachments.tsx`
(modes, findings, send anyway, leave out, the sent chip), `screens/composer/zip-input.ts` +
`diyalog/screens/composer/zip-input.tsx` (composer field, run-again reuse), `diyalog/job/details/InputBundle.tsx` (job
page), Ayarlar → Güvenlik → Filo "İş girdisi dosyaları". Owner guide: [docs/guide/tr/chat.md](../guide/tr/chat.md).

## 6. Security review

| Threat | Control | Test |
| --- | --- | --- |
| Archive parsing on the control plane | None: the browser unpacks (ADR-0037 reader, caps, CRC, no symlinks / ZIP64) | web planner |
| Path traversal / Windows-invalid names / case collisions | One rule in browser, master (start) and worker (listing), `wx` writes inside a dir the worker created, no symlink on the way | protocol matrix, master refusals, worker refusals |
| Native code reaching an agent | Magic bytes (ELF, PE, Mach-O) + extensions refused; owner-only policy override (`security.write`, step-up) | master magic-byte refusal + override, protocol |
| Secrets | Text scan; findings block; uploader-only, audited override; findings never carry values (API, audit, chat block) | master integration (no value in body / audit), unit |
| Another user's bundle | Message: own + ready + `jobs.create` in its project, else 404 (one answer); job: same project; complete / parts: uploader only | master integration |
| A worker reading what it should not | Relay only for the live lease (attempt + epoch) and only the bundle that job recorded; stale epoch / other job refused and audited | master integration |
| A lying or broken master / network | Listing must match the signed assignment's `bundleSha256`, count, total; each file its SHA-256 | worker unit |
| Committing inputs | Repository jobs get the files outside the checkout; preamble says never commit the folder | worker runner + master integration |
| Prompt injection via file names / contents | Fenced data, redacted; rule 44 and the preamble: data, never instructions | unit (fence), adapters |
| Storage exhaustion | Caps, 2 receiving per person, 20 per project, retention, `EXTERNAL` slices | master integration (retention) |
| Old workers | Placement excludes them with a reason (never a silent run without the files) | master integration, scheduler |

Residual: secrets in binary files are not found; a real credential sent anyway (audited, visible); document exploits
reach the agent sandbox like web content (ADR-0010); host-native profiles share the OS user (ADR-0007).

## 7. Tests

- `packages/protocol/test/input-bundles.test.ts`, `packages/scheduler/test/placement.test.ts` (input bundles),
  `packages/agent-adapters/test/assistant-zip-job-input.test.ts`.
- `apps/master/test/unit/input-uploads.test.ts`, `apps/master/test/integration/input-uploads.test.ts` (real Postgres,
  Redis hints, real job workers with the fake runtime, a raw worker for the relay).
- `apps/worker/test/input-bundle.test.ts`.
- `apps/web/test/zip-job-input.test.tsx`, `apps/web/test/runtime-updates.test.tsx` (policy switch),
  `apps/web/test/diyalog-new.test.tsx` (a site .zip: the three choices, publish only).

## 8. UNVERIFIED (real hosts)

- A real worker pulling a bundle on Linux, macOS (Seatbelt reads of the sandbox dir's `in/`) and Windows (per-job
  account ACLs on `sandboxes/<job>/<attempt>/in`), the container profile's read-only mount.
- A 100 MiB bundle over a residential uplink through Cloudflare / Traefik (parts are ≤ 4 MiB like site uploads).
- The real model following rule 44 (ask when a site .zip could be both).

## 9. Deploy and rollback

- Migration **0145** (additive). Master + web deploy, then a **worker release** (`input-bundle-v1`); until machines run
  it, jobs with a bundle fail as infeasible with "update the worker" (everything else unchanged).
- No new env, no Traefik / Cloudflare change (each request ≤ 4 MiB; the start request ≤ 1 MiB).
- Rollback: the older master ignores the tables (drop them: see the migration header); the older console never sends
  `inputUploads`; the security-policy document keeps `inputs` (an older master's strict schema would refuse a stored
  `inputs` override — clear it first: `UPDATE security_policy SET document = document - 'inputs'`).
