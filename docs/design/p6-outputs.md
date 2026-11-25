# p6-outputs — one screen for what jobs produced

- **Task:** `p6-outputs`. **Date:** 2026-10-16.
- **Owner request (2026-10-16):** one screen to see the links of the websites we published, plus artifact-like content
  (files) — open, preview, download — with notes.
- **Owner decisions:** the screen is called **Outputs** (sidebar item between Jobs and Automations; route `/outputs`);
  notes are **per-item notes plus free-standing note cards**, kept on the Outputs screen and **not** written to Context
  (agents never receive them).
- **Migration:** 0060 (`output_items`, `output_item_notes`, `output_notes`, two read-model indexes).
- **Worker release:** none. Master + web only.

## 1. What already existed (reused, not copied)

| Piece | Where | Role here |
| --- | --- | --- |
| Workspace job outputs (`out/` files + `summary.md`) | `job_artifacts` kind `output` / `summary`, `GET /jobs/:id/artifacts/:artifactId` (`jobs.read`, sandbox CSP, nosniff, `?inline=1` for text/images) | Files; download and preview go through this route unchanged (plus PDF inline, §5) |
| Run artifacts | `job_events` kind `artifact` (ARTIFACT_REF metadata, e.g. `attempt.diff`), `GET /jobs/:id/diff` | Files with metadata only; the diff previews through the existing verified-diff route |
| Live sites | `ops_actions` (`pages.deploy`, `pages.rollback`, `coolify.deploy`, `coolify.rollback`) with `result.url` / target fqdn, `liveUrl()` of `ops/on-success.ts` | Sites (latest successful deploy per project, target, environment) |
| Deploy-on-success | `job_deploy_on_success` | Unchanged; the job's Deploy card links to Outputs |
| Site bundles | `job_artifacts` kind `site` (`site-bundle.json`, secret-scanned, never listed to the console before) | Read-only "Site files" preview of a site's source job (§5) |
| Viewers | `MarkdownView` (element-building, no HTML), `DiffView`, `WorkspaceArtifacts` preview rules | Reused in the Outputs viewer |

### Retention and storage (checked)

- **Workspace files** (`job_artifacts`): content in Postgres (`bytea`), at most 20 files / 15 MiB per attempt, 5 MiB per
  file. Kept as long as the job unless the workspace project has `artifact_retention_days` (1–3650) and/or
  `storage_quota_bytes`; the `workspace-storage` tick step (every 5 min) then drops the **content** of files of
  finished jobs older than the retention, and the oldest files while over the quota (rows and metadata stay:
  `pruned_at` / `pruned_reason`). Site bundles follow the same rules.
- **Run artifacts** (`job_events` rows): metadata only, deleted with all live rows of a job 30 days (`live.retentionDays`)
  after the job ended (hourly sweep). The diff itself is read live from the git provider.
- **Sites**: hosted by Cloudflare Pages / Coolify; the master keeps only the ops action record (no retention).

## 2. Read model — `GET /outputs`

One SQL statement (`OutputsService.list`) unions four sources, joins the people's metadata and pages the result:

| type | key | source |
| --- | --- | --- |
| `site` | `site:<target>:<env>` — target `pages:<pages project>` or `coolify:<md5 of sorted resource uuids, 16 hex>` | `DISTINCT ON (project, target, env)` over **succeeded** deploy/rollback actions, newest `finished_at` first; URL = `liveUrl(result, target)` (https Pages URL, else the first http(s) fqdn); source job = `params.jobId` or `source.jobId` |
| `file` (workspace) | `file:<job uuid>:<artifact id>` | `job_artifacts` kind `output` / `summary`, newest attempt per artifact id; expiry = `created_at + retention days` (null when pinned / no retention / removed) |
| `file` (run) | `run:<job uuid>:<artifact id>` | `job_events` kind `artifact` whose id is not a stored workspace artifact (`ws-*` and the site bundle excluded); expiry = job end + live retention |
| `note` | `note:<uuid>` | `output_notes` (body excerpt ≤ 2 000 characters in lists) |

- **Scope:** `outputs.read` (viewer) — collection requests list the subject's visible projects (`visibleProjects`);
  `?project=` of a hidden project is a 404 (route authz). Sites, files and notes of one project share that rule
  (files are also readable through `jobs.read`, sites through `deploy.read`: both viewer, same project).
- **Filters:** `project`, `type` (site · file · note), `job`, `from` / `to` (ISO instants on the item time), `pinned`,
  `tag`, `q` (ILIKE with escaped wildcards over name, title, tags, note-card body, site URL and the item's notes
  thread), `key` (exactly one item — deep links and writes), `limit` ≤ 100, `offset` ≤ 10 000. Order: pinned first,
  newest first. `total` = `count(*) OVER ()`.
- **Indexes (0060):** `job_events_artifact_idx` (partial, kind `artifact`), `ops_actions_succeeded_deploy_idx` (partial).
  Workspace files use the existing `job_artifacts_job_idx` through `jobs.project`.

## 3. Metadata, notes and the API

`output_items` (one row per item someone titled, tagged, pinned or noted; `UNIQUE (project, item_key)`; file/run rows
carry `job_id` + `artifact_id`), `output_item_notes` (thread: body ≤ 20 000 characters, author, timestamps),
`output_notes` (cards: title ≤ 200, body ≤ 20 000, ≤ 20 tags, ≤ 20 https links, pin). A write first resolves the key
through the read model **in the body's project**: a key that names nothing there (another project's job, a made-up key)
is a 404, so rows cannot be planted for foreign items.

| Route | Action (min role) | Notes |
| --- | --- | --- |
| `GET /outputs` | `outputs.read` (viewer) | §2 |
| `PUT /outputs/items` `{project, key, title?, tags?, pinned?}` | `outputs.write` (operator) | audited `outputs.item.update` |
| `GET /outputs/thread?project&key` | `outputs.read` | notes of an item, oldest first, ≤ 500 |
| `POST /outputs/item-notes` `{project, key, body}` | `outputs.write` | audited `outputs.item_note.create`; ≤ 500 per item |
| `PATCH` / `DELETE /outputs/item-notes/:id` | `outputs.write` + author, or owner/admin | refusals audited (`denied`, `not_author`) |
| `POST /outputs/notes` | `outputs.write` | audited `outputs.note.create`; ≤ 2 000 cards per project |
| `GET /outputs/notes/:id` | `outputs.read` | full body |
| `PATCH` / `DELETE /outputs/notes/:id` | `outputs.write` + author, or owner/admin | audited |
| `POST /outputs/zip` `{project, keys[≤100]}` | `outputs.read` | §4; audited `outputs.zip` |
| `GET /jobs/:id/site-bundle`, `GET /jobs/:id/site-bundle/file?path=` | `jobs.read` | §5 |

**Limits:** central request classes (read 600/min, write 120/min per user) plus per-user buckets `outputs-write`
60/min and `outputs-zip` 10/min (Redis limiter, 429 + `Retry-After`); the global 64 KiB body limit (zip 32 KiB);
Zod bounds on every field (tags `^[\p{L}\p{N}][\p{L}\p{N} _.-]*$`, ≤ 40 characters; links `https:` without
credentials; no NUL). Every route is in the RBAC matrix (`outputs.read` viewer, `outputs.write` operator, both
project-scoped) and covered by route-coverage.

## 4. Pinned items and the retention

- `StorageSweeper` (retention and quota passes, `evictionPlan`, `#evictable`) skips `job_artifacts` rows with a pinned
  `output_items` row on the same `(job_id, artifact_id)`. Pinned files still count against the quota — a quota full of
  pinned files refuses new uploads with the existing `storage_quota_exceeded` message (unpin to free room).
- `LiveStore.purge` keeps the `artifact` event of a pinned `run:` item (all other live rows of the job go as before).
- Sites are hosted elsewhere and have no retention; pinning a site only sorts it first.
- Unpinning makes the item subject to the next sweep again (expiry shown again).

## 5. Preview and download

- **Single file:** the existing artifact route (`attachment`; `?inline=1` for text / raster images with
  `default-src 'none'; style-src 'unsafe-inline'; sandbox` + nosniff + CORP same-origin).
- **PDF (new):** `?inline=1` now also serves `application/pdf` inline for the browser's PDF viewer in a same-origin
  `<iframe>` of the drawer, with `default-src 'none'; object-src 'self'; frame-ancestors 'self'` and nosniff — **no
  `sandbox` directive**, because browsers refuse to run their PDF viewer in a sandboxed document. Without `?inline=1`
  a PDF stays an attachment. PDFs were magic-byte checked when stored (p5-research-workspace).
- **In-app viewer** (`FileViewer.tsx`): Markdown → `MarkdownView` (React elements, no HTML, no links); text/YAML/log →
  `<pre>`; JSON → bounded tree (≤ 2 000 nodes, else pretty text); CSV/TSV → table of text (≤ 500 rows × 50 columns);
  images → `<img>` from the same-origin route; PDF → iframe above; `attempt.diff` → `DiffView` over `/jobs/:id/diff`;
  text previews cut at 200 000 characters. Removed files and run artifacts without stored content say so.
- **HTML (site bundles only — workspace files cannot be HTML):** `GET /jobs/:id/site-bundle/file` serves `text/html`
  with `default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox` and the console shows it only in
  `<iframe sandbox="" referrerpolicy="no-referrer">` (no `allow-scripts`, no `allow-same-origin`), with a "Source" toggle.
  Raster images are served as images; scripts, CSS, SVG, JSON, XML and manifests as `text/plain` (source view);
  fonts are not served. A bundle the master's secret scan flagged (`redacted`) is never served (409).
- **Multi-select ZIP:** `POST /outputs/zip` takes up to 100 keys of **one** project; only stored workspace files of
  that project are included (others are listed in `MANIFEST.txt` as not included); the total of the stored sizes must be
  ≤ 50 MiB (checked before the first byte, 413 `zip_too_large`); nothing stored → 409 `zip_empty`. The archive streams
  (stored entries, CRC-32, UTF-8 names, one file in memory at a time) via a minimal writer (`outputs/zip.ts`); entry
  paths are `<job id prefix>/<sanitised name>` (no absolute paths, `..`, backslashes or control characters; unique).

## 6. Console

- Sidebar **Outputs** (daily group, between Jobs and Automations; under "More" on phones). `/outputs` with URL tabs
  `All · Sites · Files · Notes` (the shared `Tabs`, wrapping, no horizontal scroll), filters (search, project, from/to,
  pinned only, tag chip, job chip from `?job=`), cards ⇄ list toggle (remembered per browser, failure-safe), "Show
  more" paging, multi-select of downloadable files with a sticky "Download as ZIP" bar (one project per ZIP).
- Item drawer (`Drawer`, full screen on phones): site — **Open site** (`target=_blank rel="noopener noreferrer"`),
  address, provider/env, deploy link (`/deploys/:id`: history, rollback), source job, "Site files"; file — Download,
  Open job, preview, type/size/kept-until/SHA-256; title/tags/pin editor (operators); notes thread (Markdown as text;
  edit/delete own, admins any); note cards — body, https links, tags, edit/delete.
- Links in: job page Deploy card ("Show in Outputs"), workspace artifacts ("Open in Outputs"), chat deploy-on-success
  note ("Show in Outputs", from the message's `meta.jobId`), deep link `/outputs?item=<key>`.

## 7. Security review

| Threat | Control | Test |
| --- | --- | --- |
| Seeing another project's sites/files/notes | Collection queries filter by visible projects; `?project=` / body project / note ids resolve to their project and a hidden one is a 404 | integration: outsider 404 on list, write, note, zip, site bundle; RBAC matrix |
| Viewer writes | `outputs.write` = operator; notes additionally author-or-admin | integration: viewer 403; other operator 403 (`not_author`, audited); owner deletes |
| Planting metadata for foreign or invented items | Writes resolve the key through the read model in the body's project; strict key grammar | integration: other project's file key → 404 |
| Stored XSS through notes, names, titles, tags, CSV/JSON/Markdown content | Everything rendered as React text; `MarkdownView` builds elements only (no HTML, no links); CSV/JSON as text cells/nodes | web: `<img onerror>` note and `<b>` CSV cell render as text |
| HTML / SVG / JS of a site bundle running on the console origin | HTML only in `iframe sandbox=""` + response CSP `sandbox` and `default-src 'none'` (opaque origin, no scripts, no network except `data:` images); JS/CSS/SVG/JSON served as `text/plain` + nosniff; flagged bundles refused | integration: headers, `text/plain` for JS/SVG, 409 flagged; web: iframe `sandbox=""` |
| Browser content sniffing / framing by others | `X-Content-Type-Options: nosniff`, CORP same-origin, helmet `X-Frame-Options: SAMEORIGIN`, PDF `frame-ancestors 'self'` | integration: PDF/MD headers |
| PDF viewer without sandbox | Inline only with `?inline=1`, only `application/pdf` stored after a magic-byte check; `default-src 'none'`; the browser PDF viewer runs isolated from the page's DOM | integration: inline + no `sandbox` only for PDF; **UNVERIFIED in real browsers** (see below) |
| Malicious site links (`javascript:`, credentials, http) | Note links: Zod `https:` without user/password; site URLs: `liveUrl` (https Pages URL / http(s) fqdn from Coolify) and the console renders only `https:` (`httpsUrl`), `rel="noopener noreferrer"`, `referrerpolicy` | unit + web |
| ZIP bombs / memory exhaustion / zip-slip | ≤ 100 files, ≤ 50 MiB checked before streaming, stored entries (no compression ratio), one file in memory, sanitised unique paths | unit (paths, valid archive, `unzip -t`), integration (413, 400 > 100 keys, foreign file excluded) |
| Abuse / flooding | Central class limits + per-user `outputs-write` 60/min, `outputs-zip` 10/min; caps per item / project | covered by the limiter (shared code); caps in service |
| Retention bypass beyond intent | Only explicit pins (operator+, audited) exempt; quota still counts pinned bytes | integration: pinned kept / unpinned pruned; pinned run event survives live purge |
| Notes leaking into agent context | Separate tables; never part of context bundles or job specs | design (no code path) |
| Audit | Every write and the ZIP download audited with ids, counts and project (no note text) | integration: audit rows |

**UNVERIFIED (needs a real browser on the deployed console):** the PDF iframe under the console's CSP/COEP
(`Cross-Origin-Embedder-Policy: require-corp` — the master sends CORP same-origin and helmet's COEP on the file response)
in Chrome, Firefox and Safari, and the sandboxed HTML iframe rendering. jsdom tests cover attributes and headers only.
Fallback in the UI: Download.

## 8. Rollback

Forward-only migration; rolling the code back leaves three unused tables and two indexes (harmless). The PDF inline
change is one branch in `workspaces/routes.ts` `sendFile`. No worker or protocol change.
