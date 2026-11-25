# ADR-0037: People may publish an uploaded static site through the master (Pages deploy from an upload)

- **Status:** Accepted — extended by [ADR-0038](0038-pre-approved-publish-bundle.md) (an upload can be published
  with the bundle: create the Pages project, deploy, attach the domain, write its CNAME — one approval)
- **Date:** 2026-10-18
- **Deciders:** owner (request 2026-10-18: publish a ready-made HTML presentation with MP4 clips, ~5.5 MB /
  ~30 files, to Cloudflare Pages through the panel, on `site.example.org`, without disturbing project
  genel's Pages target `cluster-general`); implemented by `p10-site-upload`
- **Amends:** ADR-0028 §2 / §8 — `pages.deploy` gains a second source (`uploadId`) next to a job's output, and a Pages
  action may name one of the project's further Pages projects (`pagesProjects`) instead of only the target. Everything
  else of ADR-0028 (master-held token, typed ops actions, policy, approval, step-up, audit, rollback) stays.
- **Related:** docs/design/p10-site-upload.md (design + security review), docs/design/p6-deploy-integrations.md,
  docs/design/p6-pages-create.md, ADR-0006, ADR-0009, ADR-0010, ADR-0030, AGENTS.md rules 4, 7, 10.

## Context
Until now everything `pages.deploy` published was produced by a job (its site bundle or output files), and a job's
site bundle is limited to one ≤ 5 MiB artifact without video. A person with a finished site had no way to publish it
through Remyral, and every Pages action reached only the project's single Pages target — creating a second Pages
project for the same Remyral project either replaced the target or was forgotten.

## Decision
1. **Human uploads.** A person who may request deploys in a project (`deploy.request`, operator+) can upload a static
   site from Project → Deploy (folder, or a .zip unpacked in the browser). The master accepts it only as a chunked,
   resumable upload (`/projects/:id/site-uploads`, ≤ 4 MiB per request, CSRF), checks the declared file list before
   any byte (site file types incl. mp4/webm, safe relative paths ≤ 8 deep, no hidden files, ≤ 500 files, ≤ 25 MiB per
   file — Cloudflare Pages' asset limit — ≤ 50 MiB total, `index.html` at the root) and every file after assembly
   (SHA-256, magic bytes of binary types, the secret scanner on text types — refusals name file, rule and line, never
   the value) and stores it per file (migration 0083). The master never unpacks archives.
2. **Publishing is an ops action.** `pages.deploy {uploadId, env|branch, pagesProject?}` goes through the unchanged
   ADR-0028 pipeline: project-scoped, policy (preview auto by default, production approval + always-fresh step-up),
   re-plan before execution (the plan key includes the file hashes), idempotency, rate limit, audit, notifications,
   health check, auto-monitor and rollback. An upload of another project is "not found".
3. **The console never serves an upload.** The API returns metadata (paths, sizes, hashes, types) only; nothing reads
   the bytes except the ops service's Cloudflare upload. Uploaded HTML therefore never runs on the console origin.
4. **Further Pages projects.** `DeployTargets.pagesProjects` (≤ 20 names) lists Pages projects a project may use
   besides its target. "Create a new Pages project" without "use as target" adds the new project there (the target is
   untouched); adopting an existing project (as target or not) and editing the list are deploy-target changes
   (project admin + step-up). `pages.deploy`, `pages.add_domain` and `pages.rollback` accept `pagesProject` only if it
   is the target or on that list; any other name is refused (403).
5. **Retention.** Unfinished uploads expire after an hour without a part; a ready upload never deployed is deleted
   after 7 days; a project keeps its newest 5 (an upload an ops action still waits for is kept).

## Threat model impact
| Threat | Mitigation | Residual |
| --- | --- | --- |
| Stored XSS / phishing page on the console origin | Uploads are never served, previewed or downloaded by the console; responses carry metadata only | — |
| Publishing secrets | Secret scanner on every text file (the same rules as the memory/context scanners); a hit discards the upload and names file + rule + line | Secrets the scanners cannot recognise; public-by-design keys that look like secrets are refused (false positives) |
| Disguised executables / archives | Allow-listed extensions plus magic-byte checks for every binary type; no archive types | A valid file of an allowed type with hostile content (e.g. a malicious script in the site itself) — the site is public content, published only after the deploy policy |
| Zip-slip / zip bombs | The browser unpacks (declared-size and ratio caps, inflation stops at the declared size, CRC check, symlinks refused); the master receives plain files and re-checks every path (no `..`, absolute, backslash, hidden) and size | A hostile zip only affects the uploader's own tab |
| Resource exhaustion on the master | ≤ 4 MiB per request, ≤ 50 MiB per site, ≤ 2 unfinished uploads per person, ≤ 5 kept per project, 1 h / 7 d expiry; per-project ops rate limit | 5 × 50 MiB per project in Postgres |
| Someone else's site or Pages project | Uploads are project-scoped and bound to the uploader until complete; `pagesProject` must be the target or on the admin-controlled list | An admin listing another project's Pages project (same as setting it as target today) |
| Deploying without the owner | Same ADR-0028 policy: production needs approval + always-fresh step-up; preview auto is tightenable | A human approving a plausible malicious site |

## Rollback
- Of a deploy: the existing `pages.rollback` (previous production deployment), also from the health check.
- Of the feature: stop offering the card (web) — the routes refuse nothing else; `DELETE FROM site_uploads` removes all
  stored sites. Migration 0083 is additive (three tables); `pagesProjects` defaults to `[]`.

## Alternatives considered
- **Raise the job site bundle container** (one JSON artifact with base64) — it flows through worker artifact limits
  and the job path; uploads do not need a job at all.
- **One multipart request of ≤ 60 MiB** — the master's 30 s request timeout and slow uplinks make it unreliable; parts
  of 4 MiB are resumable and far below Traefik's and Cloudflare's 100 MB proxy limits.
- **Server-side .zip extraction** — rejected: the master never parses untrusted archives.
- **Free Pages project names per deploy** — rejected: an operator could reach any Pages project of the account.

## Verification
apps/master/test/integration/site-uploads.test.ts (authz, CSRF, limits, paths, secret and magic refusals, a > 5 MB
site with an mp4 deployed to a further Pages project through the fake Cloudflare, approval + step-up, rollback,
retention), pages-create (create without target), unit site-upload-checks, packages/protocol site-files, web
site-upload / pages-create. **UNVERIFIED-LIVE** against the real Cloudflare account until the owner runs the steps in
docs/guide/tr/deploy-entegrasyonlari.md §5c.
