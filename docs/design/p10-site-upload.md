# p10-site-upload — publish an uploaded static site to Cloudflare Pages through the panel

- **Task:** `p10-site-upload`. **Date:** 2026-10-18.
- **Owner need:** publish a ready-made static site (an HTML presentation with MP4 clips, ~5.5 MB, ~30 files) to
  Cloudflare Pages through the panel, on the custom domain `site.example.org` (zone `example.org` is
  allowed for project genel), as the Pages project `remana-agent-cluster`, without disturbing genel's current target
  `cluster-general`.
- **Decision:** [ADR-0037](../adr/0037-human-uploaded-static-sites.md) (amends ADR-0028 §2 / §8).
- **Builds on:** [p6-deploy-integrations](p6-deploy-integrations.md) (ops actions, Pages Direct Upload),
  [p6-pages-create](p6-pages-create.md), [p10-verify-health](p10-verify-health.md) (health check, auto-rollback),
  the release upload (chunked parts, `apps/master/src/releases/uploads.ts`).
- **Migration:** 0083 (`site_uploads`, `site_upload_parts`, `site_upload_files`). **Worker release:** not needed for
  uploads; needed only for job site bundles to include mp4/webm (the worker packs bundles with the shared
  `SITE_FILE_TYPES`).
- **Live status:** UNVERIFIED-LIVE — every Cloudflare call ran against `apps/master/test/helpers/fake-ops.ts`.

## 1. Why not the existing paths

| Path | Limit that blocks the owner |
| --- | --- |
| `pages.deploy {jobId}` | needs a succeeded job; the site must be produced by an agent |
| Job site bundle | one artifact ≤ 5 MiB of JSON (≈ 3.7 MB of files), no video types |
| Job inputs | ≤ 10 files / 10 MiB, no video, and they are inputs, not a site |
| Pages actions | reach only the project's single Pages target; "create" without "use as target" was forgotten |

## 2. Shape

```
 browser (Project → Deploy → Upload a site)
   folder (input webkitdirectory) ─┐   .zip → unpacked in the browser (siteZip.ts: caps, CRC, no symlinks)
                                   ▼
   planSite: strip the one shared top folder, skip OS litter, apply @remyral/protocol/site-files rules
             → file list · total · refused files (path + reason) shown BEFORE sending
   SHA-256 per file → POST /projects/:id/site-uploads {files:[{path,size,sha256}], label}   (checked, nothing stored
                                                                                              but the manifest)
   concatenated bytes in parts ≤ 4 MiB → PUT …/:uploadId/parts/:n (X-Part-SHA256; retries; resume)
   POST …/:uploadId/complete → master: per-file size + SHA-256, magic bytes (binary), secret scan (text)
                               → site_upload_files rows (state ready) | 422 refused (discarded, audited)
   Deploy to preview / production → POST /deploy/actions/preview → Review (diff, policy) → POST /deploy/actions
        {kind: pages.deploy, params: {uploadId, env, pagesProject?}}
                                   ▼
 ops service (unchanged pipeline): project-scoped plan (files from the upload, plan key over file hashes),
   policy → auto | approval | approval_step_up, approval re-plan, Direct Upload, poller, health check,
   auto-rollback, notifications, audit
```

| Piece | Where |
| --- | --- |
| Site types (+ mp4, webm), path rule, magic bytes, limits (pure; shared with the console) | `packages/protocol/src/site-files.ts` (`@remyral/protocol/site-files`; `workspace.ts` re-exports the types) |
| Migration | `apps/master/migrations/0083_site_uploads.sql` |
| Checks (manifest, content, refusal text) | `apps/master/src/site-uploads/checks.ts` |
| Upload service (start, parts, complete, list, get, delete, deploy files, retention) | `apps/master/src/site-uploads/service.ts` |
| REST + OpenAPI | `apps/master/src/site-uploads/routes.ts` |
| `pages.deploy` source `upload`, `env`, `pagesProject`; further Pages projects | `apps/master/src/ops/model.ts`, `service.ts`, `routes.ts` |
| Pages asset batches by size, longer upload time-out | `apps/master/src/ops/cloudflare.ts` |
| Auto-rollback "newer deploy" check per Pages project | `apps/master/src/verify/health.ts` |
| Console | `apps/web/src/screens/deploy/SiteUploadCard.tsx`, `lib/siteUpload.ts`, `lib/siteZip.ts`, `api/siteUploads.ts`; Project → Deploy "Further Pages projects", Create-project toggle text, domain project picker, diff "from an uploaded site" |

## 3. Limits and rules

| Rule | Value | Where enforced |
| --- | --- | --- |
| File types | the site types (HTML, CSS, JS, JSON, map, txt, xml, webmanifest, SVG, PNG, JPEG, GIF, WebP, AVIF, ICO, WOFF, WOFF2) **+ mp4, webm** | browser (shown), master start |
| Per file | ≤ 25 MiB — Cloudflare Pages' asset limit (developers.cloudflare.com/pages/platform/limits, Context7 2026-10-18) | browser, master start, DB CHECK |
| Site | ≤ 500 files, ≤ 50 MiB, `index.html` at the root | browser, master start, DB CHECK |
| Paths | relative, `/`-separated, segments `[A-Za-z0-9_][A-Za-z0-9 ._@()+-]{0,99}`, ≤ 8 segments, ≤ 300 chars, no `.`/`..`, no hidden files or folders (not even `.well-known`) | browser, master start |
| Request | ≤ 256 KiB for the start (file list), ≤ 4 MiB per part (route-only body limit; the rest of the API keeps its class limits) | Fastify `bodyLimit` per route; the octet-stream parser exists only in the upload scope |
| Content | SHA-256 per file and per part; magic bytes for PNG/JPEG/GIF/WebP/AVIF/ICO/WOFF/WOFF2/MP4/WebM; secret scan (`scanForSecrets`, observability default rules) on text types | master complete |
| Concurrency | ≤ 2 unfinished uploads per person (advisory lock) | master start |
| Retention | receiving: 1 h sliding; ready and never deployed: 7 days; ≤ 5 newest ready per project (an upload an `awaiting_approval`/`executing` deploy refers to is kept) | `complete` (per project) + tick step `site-uploads` (≤ 1/min) |

Why parts and not one ≤ 60 MiB multipart request: the master's Node server has a 30 s whole-request time-out
(`SLOW_REQUEST_TIMEOUTS.requestMs`, server-wide, cannot be raised per route) — 60 MiB in 30 s needs ≥ 16 Mbit/s of
upload. Parts of 4 MiB pass on slow links, are retried individually, can be resumed, and stay far below Cloudflare's
100 MB proxied request limit and Traefik's defaults. Chrome sends each part straight from disk (`Blob.slice`).

Why the zip is unpacked in the browser: the master never parses untrusted archives (no new dependency, no zip-slip or
bomb surface on the control plane). `siteZip.ts` reads the central directory, supports stored/deflate only (via
`DecompressionStream('deflate-raw')`), refuses encrypted, multi-disk, ZIP64 and symlink entries, refuses an entry whose
declared size exceeds 25 MiB or whose ratio exceeds 200, stops inflating at the declared size, caps the total at
50 MiB and checks every CRC-32. Entry names are only data: the path rule above refuses `..`, absolute and backslash
names before anything is sent, and the master checks them again.

## 4. `pages.deploy` from an upload

Params (strict): exactly one of `jobId` / `uploadId`; `branch` **or** `env` (`production` → the Pages project's
production branch, `preview` → `remyral-preview`; default preview); `pagesProject` (optional, see §5); `directory` and
`bundleSha256` belong to job deploys only.

Plan: the upload must be `ready` and in the same project (else 404 `upload_not_found`); each file's stored SHA-256 is
re-checked when read; diff `{source: 'upload', uploadId, upload: {label, uploadedBy, fileCount, siteSha256},
fileCount, bytes, files[], branch, env, project, productionBranch, domains (production)}`; the plan key covers the
Pages project, the environment and every file's hash, so an approval re-plans against the same bytes. Everything else
is the job-deploy path: policy matrix (preview `previewDeploy`, production `productionDeploy`), approval by
`deploy.approve` with the always-fresh step-up, idempotency, per-project rate limit, notifications, Direct Upload,
the `ops-deploying` poller, the post-deploy health check, opt-in auto-rollback and the manual "Roll back". On a
Cloudflare-accepted deploy the upload records `last_deployed_at` / `last_action_id` (retention keeps it).

Cloudflare Direct Upload batches are now bounded by ≤ 50 files **and** ≈ 30 MiB of base64 per request (a 25 MiB file
goes alone, ≈ 33 MiB), with a 120 s time-out (other API calls keep 15 s). The batch size is our choice
(UNVERIFIED-LIVE, like the asset key — docs/compat/cloudflare.md). The ops limit `maxPagesBytes` is 50 MiB.

## 5. Further Pages projects (item 4 of the request)

The existing "Create a new Pages project" **did** work with "Use as this project's Pages target" off — but the new
project was not remembered anywhere, and Pages deploys / domains could only reach the target. Design choice: a
per-project list `DeployTargets.pagesProjects` (≤ 20) next to the target, rather than a free per-deploy name:

- `pages.create_project` without `useAsTarget` adds the new project to the list (audited `ops.targets.write`,
  `change.pagesProjects.added`); the target is untouched; the diff says "the Pages target stays X".
- `ifExists: adopt` is now allowed without `useAsTarget` (adds the existing project to the list) — both forms need
  `deploy.targets.write` + a current step-up (an operator cannot point the project at an arbitrary existing project).
- `pages.deploy`, `pages.add_domain`, `pages.rollback` take `pagesProject`; it must be the target or on the list,
  else 403 `pages_project_not_allowed`. Without it they use the target, as before.
- Project admins can edit the list in Project → Deploy ("Further Pages projects", standard step-up like every
  target write).
- The deploy-health auto-rollback's "a newer deploy happened" check now compares the Pages project too.

Owner flow for genel: Create a new Pages project `remana-agent-cluster` (target toggle off) → approve → Attach a
custom domain, Pages project `remana-agent-cluster`, `site.example.org` (CNAME in the allowed zone,
policy `pagesProject` + `dnsChange`) → approve → Upload a site → Deploy to production on `remana-agent-cluster` →
approve with a code. `cluster-general` is never touched.

## 6. Security review

| Area | Finding / control | Test |
| --- | --- | --- |
| Console origin (stored XSS) | Upload bytes are never returned: list/get carry metadata only; only `OpsService` reads them (Direct Upload) | integration: GET body has no HTML / base64 |
| Authorization | Start/parts/complete/delete: `deploy.request` on the project (operator member), reads `deploy.read`; parts/complete only by the uploader (404 for others, even admins); delete by the uploader or `deploy.approve`; an upload is invisible to other projects | integration: viewer 403, non-member 404, other user's part 404, cross-project deploy 404; rbac-matrix / route-coverage cover the new routes automatically |
| CSRF | Every write route is a cookie-session write (global CSRF check) | integration: start without the CSRF header → 403 |
| Body size / DoS | Route-only limits (256 KiB start, 4 MiB part); octet-stream parser in an encapsulated scope; per-user cap; retention; 50 MiB site | integration: limits, cap, retention |
| Path safety | One rule (`sitePathProblem`) in browser and master; no file system writes anywhere (rows only) | unit + integration path matrix |
| Type confusion | Extension allow-list + magic bytes for every binary type | integration: script named .mp4 / GIF named .png refused |
| Secrets | Text types scanned; refusal names file + rule + line; upload discarded; audit holds names/rules/lines only | integration: GitHub token in index.html; unit: Anthropic key |
| Integrity | SHA-256 per part, per file at complete, re-checked when deploying; plan key over file hashes | integration: bad part hash 422 |
| Policy / approval | Unchanged ADR-0028 pipeline; production approval + always-fresh step-up | integration: operator cannot approve, stale step-up 403, approve → deploy, rollback |
| Pages project reach | Only the target or the admin-controlled list; adopt needs admin + step-up | integration + unit |
| Token | Unchanged (master-held); responses checked for the canary token | integration |
| Archives | Unpacked only in the browser with caps; the master never sees a zip | web: zip-slip names refused, symlink, ratio, declared-size, overflow, CRC |

Residual risks: secret patterns the scanners do not know (and false positives for public keys such as Firebase
`AIza…` keys, which are refused); a human approving a malicious-but-plausible site; Pages behaviour of large batches
and video content types (UNVERIFIED-LIVE).

## 7. Tests

- `packages/protocol/test/site-files.test.ts` — types incl. mp4/webm, path rule matrix, magic bytes.
- `apps/master/test/unit/site-upload-checks.test.ts` — manifest, content (secret rule + line, binaries not scanned).
- `apps/master/test/integration/site-uploads.test.ts` — authz, CSRF, limits, path refusals, parts (hash, size, owner,
  resume), secret and magic refusals, create-without-target + domain on the further project, a > 5 MB site with an
  mp4 deployed through the fake Cloudflare (asset bytes + content type checked), preview auto, production approval +
  step-up, rollback, retention, unfinished-upload expiry and per-user cap.
- `apps/master/test/integration/pages-create.test.ts`, `apps/master/test/unit/pages-create.test.ts` — updated for
  "create without target adds to the list" and "adopt needs the target right".
- `apps/web/test/site-upload.test.tsx` — plan, zip reader, chunked upload (retry, resume), card (folder pick, refused
  files, upload, deploy to the chosen Pages project, master refusals, .zip), diff; `pages-create.test.tsx` — toggle
  off, domain to a further project.

## 8. Deploy notes

- Migration **0083** (additive: three tables). Master + web deploy.
- No new env. **Traefik:** no change (each request ≤ 4 MiB). **Cloudflare proxy:** proxied requests are limited to
  100 MB — unaffected (≤ 4 MiB per request). The master's own 30 s request time-out is unaffected by design (parts).
- **Worker release:** not needed for uploads. Needed only if job site bundles should include mp4/webm (the worker packs
  bundles with `SITE_FILE_TYPES` from `@remyral/protocol`); until then a job bundle simply skips video files. The job
  bundle container stays ≤ 5 MiB.
- Cloudflare token: unchanged permissions (Account → Cloudflare Pages → Edit; Zone → DNS → Edit for the CNAME).
- Rollback: redeploy the previous master/web; `DELETE FROM site_uploads` drops stored sites. Targets are stored
  without `pagesProjects` while the list is empty, so an older master (strict schema) still reads them; a project that
  uses the list must clear it first (Project → Deploy → "Further Pages projects", or
  `UPDATE project_deploy_targets SET config = config - 'pagesProjects'`), otherwise the older master sees no deploy
  targets for it.
