# Design note: `p15-workspace-retention` — kept working files of repository-less jobs

- **Task:** `p15-workspace-retention`. **Date:** 2026-10-22. **Migration:** 0132. **Worker release:** yes (feature
  `workfiles-v1`, assistant prompt rule 33 and tool schemas).
- **Owner report (2026-10-22):** "Reposuz işler, iş bitince siliniyor. Sunum hazırlattım (HTML), Cloudflare'a deploy
  edecekti; deploy edemedi. Dosyalar artık yok, yeniden üretiyor. … Silinmesin, belli bir süre tutulmalı … istersem
  temizleyebileyim. Belki sonucu beğenip repoya aktartacağım. Ekran görüntülerini almış, onları saklamış; projeyi
  silmiş." Also: images in output previews look squashed.
- **Binding inputs:** p5-research-workspace (scratch dirs, artifacts), p5-research-workspace-next (artifact retention),
  p15-services (kept checkout hand-off), p10-site-upload, p15-github-create-repo, p15-git-central, p15-chat-cards-scroll
  (job result card / outputs drawer), ADR-0004, ADR-0007, ADR-0010, ADR-0011 (additive protocol), ADR-0056.

## 1. Decision summary

1. The **whole working directory** of a workspace (repo-less) job — `in/`, `out/`, screenshots, drafts, anything the
   agent wrote — is **kept on its machine after the job ends, whatever the outcome**, for a retention period: global
   default **14 days** (Ayarlar → Çalışma dosyaları), a workspace project may override it (Projeler → proje → Ağ erişimi
   tab of a workspace project), **0 = deleted at the end** as before. Only `out/` is still returned as artifacts
   (unchanged); the kept directory is an addition, never a replacement.
2. **Per-machine cap** (default 10 GiB): the oldest kept directory is evicted first — never one that is pinned.
3. **Pins:** an unfinished follow-up seeded from it, a pending deploy of the job (`ops_actions` awaiting approval /
   executing / deploying with `source.jobId`, `job_deploy_on_success` pending / running / requested), a running service
   from it, or an export in progress. While pinned the master keeps moving `pinnedUntil` to "now + retention"
   (sweep, ≤ 1 min), so nothing is removed before the publish it waits for finished, **and** the retention applies
   after it. "Temizle" of a pinned directory is refused (409 `workfiles_pinned`, the reasons named).
4. **Reuse instead of regeneration:** a follow-up (`continueFrom`), "Yeniden çalıştır" (composer `?from=`, chat
   `run_again`), a fix (Düzelt / deploy feedback fix jobs — they use `continueFrom`) or an explicit `keptFilesFrom`
   records a **seed** (`job_workfile_seeds`). Placement prefers the machine that keeps the files (soft score bonus);
   there the worker copies them (`local`); on another machine it fetches them through the master (`relay`:
   WORKFILES_FETCH fenced by its live lease → WORKFILES_REQUEST to the keeping machine). The preamble tells the agent it
   continues from those files. A failed seed never fails the job (a job event says so; inputs still stand).
5. **Repoya aktar:** the files (default `out/`, or a sub-folder / everything but `in/`) become **one commit on the
   project's base branch written with the provider's git data API** (GitHub: blobs, tree with `base_tree`, commit —
   verified with Context7 `/websites/github_en_rest`), a **new branch** `remyral/files-<job8>` (suffix `-2…-9` when
   taken, never forced) and a **pull request**. The master never checks out the repository (AGENTS.md rule 1). Or a
   **new private repository** (p15-github-create-repo service, linked to the project) whose default branch gets the
   files as a fast-forward of GitHub's README commit. Every file is scanned on the master first (`scanText`); one
   finding refuses the export naming file / rule / line.
6. **Deploy retry without regeneration:** "Siteye yükle" turns a folder of the kept files into a ready **site upload**
   of the project (p10-site-upload checks apply), deployable from Projeler → Deploy.
7. **Console:** job page (Ayrıntılar → Dosyalar) and Çıktılar (item drawer + "Makinelerde tutulan çalışma dosyaları")
   show state, machine, size, expiry, pins, a file tree, previews, per-file download and a zip streamed from the
   machine; Temizle per job and per machine / project (audited). Output image previews keep their aspect ratio
   (`object-contain` in a bounded box), multiple images become a thumbnail grid, hover shows a zoom affordance and a
   click opens a **lightbox** (full size, ←/→/Esc, swipe, download, next / previous across the job's images); the same
   lightbox on Çıktılar.
8. **Assistant:** `list_workfiles` (read) and `export_workfiles` (draft `workfiles_export`, acts at once on the user's
   command — p15-chat-execute-default), `draft_job.keptFilesFrom`; prompt rule 33 ("continue from the kept files,
   never regenerate what is kept").

## 2. Wire (`packages/protocol/src/workfiles.ts`, feature `workfiles-v1`; all control messages, seq 0)

| Message | Direction | Notes |
| --- | --- | --- |
| ASSIGN_JOB `execution.keepFiles {expiresAt, maxBytes}` | m → w | workspace jobs; absent → released as before |
| ASSIGN_JOB `execution.seedFiles {jobId, attemptId, mode: local\|relay}` | m → w | start from kept files |
| CAPABILITIES `workfiles {maxBytes, usedBytes, kept[]}` | w → m | reconciliation (missing → `lost`; pending deletes re-sent) |
| `WORKFILES_STATUS {…, removed[{reason: expired\|evicted\|deleted\|missing}]}` | w → m | after every keep / removal |
| `WORKFILES_REQUEST {requestId, jobId, attemptId, op: list\|read\|delete\|extend}` | m → w | reads ≤ 192 KiB per answer |
| `WORKFILES_DATA` | w → m | answer by `requestId` (only from the machine asked) |
| `WORKFILES_FETCH {attemptId, epoch, requestId, op: list\|read}` | w → m (job) | relay request of a seeding attempt |
| `WORKFILES_FETCH_DATA` | m → w (job) | relayed answer |

Pure helpers shared by worker and master: `isWorkfilePath` (relative, no `.`/`..`, no `\`, ≤ 16 segments),
`pickEvictions` (oldest first, skip pinned / protected), `workfilesEffectiveExpiry`. Scheduler: `PlacementJob.preferWorkers`
(+0.6 score; explained "it keeps the files of the job this one continues from").

## 3. Worker (`apps/worker/src/workspace/kept.ts`)

- Layout under the workspace root: `kept/<job>/<attempt>/` (the scratch dir **moved** — same file system, atomic) and
  `.remyral/kept/<job>__<attempt>.json` (0600). The workspace root is the worker's data area every job sandbox already
  confines to its own attempt dir; a later job never sees another job's kept dir except as a seed copy.
- At keep time text files are scanned with the pre-push rules + the job's exact secret values and redacted in place; a
  binary with a hit is removed (counted: `dropped`, `redacted` in the record).
- Reads: O_NOFOLLOW on the file, real path of its directory inside the kept dir; links / sockets / devices are listed as
  `other`, never read or copied. Seeds: copied without following links, the new job's own inputs win, `in/` stays
  read-only; limits 2000 files / 200 MiB / 50 MiB per file.
- Local safety sweep (hourly): removes a directory only 24 h after its expiry / pin (the master's sweep is the policy).
- Runner: `#runScratch` seeds after the inputs (phase `seed`), the preamble says how long the dir is kept and that it
  continues an earlier job; `#finish` keeps instead of releasing when `keepFiles` is set (any outcome; a paused /
  parked attempt is unchanged; a failure to keep falls back to the old release).

## 4. Master (`apps/master/src/workfiles/*`, migration 0132)

- `job_workfiles` (per attempt: worker, project, outcome, state `kept|deleting|deleted|lost`, size, files, kept / expires,
  pinned until + reason, delete reason / by / at), `job_workfile_seeds`, `workfiles_settings` (retention, cap),
  `project_workspaces.workfiles_retention_days`, `workfile_exports`, `chat_drafts.kind` + `workfiles_export`.
- `WorkfilesService`: settings, `assignment()` / `preferWorkers()` for dispatch, worker messages, request round trips
  (20 s timeout; 409 `workfiles_machine_offline`, 504 `workfiles_timeout`), list / forJob / tree / open (streamed) /
  zipEntries, pins, `remove` / `cleanup` (audited `workfiles.delete`, `workfiles.cleanup`), sweep (tick step
  `workfiles`, audited `workfiles.sweep`; machine-side evictions `workfiles.evict`), relay (`workfiles.relay`, denied
  attempts audited). The expiry is reset from the keep time when WORKFILES_STATUS arrives.
- `WorkfilesExport`: `toRepository` (branch + PR / new repository; `workfiles.export`), `toSiteUpload`
  (`workfiles.site_upload`). `GitProvider.commitFiles` (GitHub git data API; local provider: temporary index +
  `commit-tree`).
- REST: `GET /workfiles`, `GET /jobs/:id/workfiles`, `…/tree`, `…/file?path=&inline=1`, `…/zip`, `DELETE /jobs/:id/workfiles`,
  `POST /workfiles/cleanup`, `POST /jobs/:id/workfiles/export`, `POST /jobs/:id/workfiles/site-upload`,
  `GET|PUT /settings/workfiles`, `GET|PUT /projects/:id/workfiles`; `POST /jobs` + `keptFilesFrom`.
- RBAC: `workfiles.read` (viewer, project), `workfiles.manage` (operator, project; never asks for a code — everyday work
  like `services.manage`), `workfiles.settings` (admin, global; security event `projects.policy`). A new repository needs
  `integrations.github.write` + `projects.git.write`; a site upload also `deploy.request`.

## 5. Security review

| Threat | Control |
| --- | --- |
| Secrets left in kept files | redaction / drop at keep time on the worker (job values + pre-push rules); exports scanned again on the master (`scanText`), refusal names file / rule / line only |
| Path traversal / link escape | `isWorkfilePath` on both sides; O_NOFOLLOW + directory realpath check; links never read or copied; ids validated as safe segments |
| Untrusted HTML / content | served `text/plain` (sandbox CSP) for text, images / PDF only by magic bytes, HTML only for `<iframe sandbox="">` with `HTML_PREVIEW_CSP`; a plain download of HTML is `application/octet-stream` attachment; `nosniff`, CORP same-origin, `no-store` |
| Cross-project reads | every route authorizes on the job's project; relay only for the seed its job recorded and only for the live lease holder |
| A machine answering for another | answers accepted only from the machine the request went to |
| Disk exhaustion | per-machine cap with oldest-first eviction, retention, local grace sweep, transfer limits |
| Destructive clean-up | operator role, explicit two-step button, refused while pinned, audited; the sweep is system-audited |
| Repository writes | never a checkout on the control plane; a new branch only (never forced, never an existing one), PR for merging under git flow; new repositories admin-only |
| Agent instructions in files | file names / contents are data (tool results say so; prompt rule 33) |

Residual: files that were sensitive but matched no rule stay on the machine for the retention (as the scratch dir would
have during the run); host-native profiles share the OS user (ADR-0007 residual).

## 6. Tests

- protocol `workfiles.test.ts` (messages, ASSIGN fields, paths, eviction order, effective expiry), scheduler
  `prefer-workers.test.ts`.
- worker `workfiles-kept.test.ts` (kept after success / failure, redaction / drop, reads without links, eviction with a pin,
  delete / extend / sweep with grace, local seed, relay seed, preamble), `workfiles-runner.test.ts` (runner keeps after
  success / failure, released without keepFiles, same-machine and relayed follow-ups, WORKFILES_REQUEST).
- master integration `workfiles.test.ts` (assignment / retention / project 0, records + RBAC + tree / file / zip streaming,
  pin by a pending deploy past expiry then expiry after it, local / relay seed + lease fencing + audit, cap eviction
  oldest-first skipping a pinned one, Temizle + bulk clean-up audited, Repoya aktar into a real bare repository + secret
  refusal, the assistant's list / export, CAPABILITIES reconciliation → lost), RBAC matrix, security-policy catalog.
- web `workfiles.test.tsx` (lightbox: thumbnails aspect, ←/→ wrap, prev button, swipe, vertical drag ignored, Esc,
  download; panel: tree, Markdown preview, sandboxed HTML, zip link, two-step clean-up, pinned disabled, 0-day notice).

## 7. UNVERIFIED (real hosts)

- A real worker keeping / seeding on Linux, macOS (Seatbelt) and Windows (per-job accounts: the kept dir's ACLs after
  the move; `rename` within the workspace root), and a relayed seed between two real machines.
- GitHub git data API calls (`git/blobs`, `git/trees`, `git/commits`) with the panel App installation token, and a new
  private repository on the owner's personal account (p15-github-create-repo prerequisites).
- The real assistant following rule 33 (fake engine / unit level only).

## 8. Deploy notes and rollback

Migration 0132 (additive). Master + web, then a **worker release** (`workfiles-v1`): older workers never get
`keepFiles` and keep the old release rules. No new env, no Traefik change. Rollback: the old master ignores the new
tables; workers keep kept dirs until their local sweep (expiry + 24 h) — or remove `<root>/kept` by hand.
