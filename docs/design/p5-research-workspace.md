# Design note: `p5-research-workspace` — repository-less work areas

- **Task:** `p5-research-workspace`. Owner request 2026-10-14: an area for research and general tasks that are not
  tied to a code repository.
- **Date:** 2026-10-14
- **Binding inputs:** ADR-0004 (leases, fencing, idempotency), ADR-0006 (secrets), ADR-0007 (sandbox profiles),
  ADR-0010 (untrusted content), ADR-0011 (additive protocol), ADR-0015 (panel-managed workers, local ceiling),
  p3-sandbox (egress proxy), p3-workspace (layout, retention), p4-orchestration, p4-quotas, p5-rbac,
  p5-nav-sections, p5-live.

## Decision summary

1. **A project kind, not loose jobs.** `projects.kind ∈ {repository, workspace}`; existing projects are
   `repository`. Migration 0033 creates the default workspace project **`genel`** ("General", egress `web`).
   Workspaces are projects in every other respect: RBAC memberships, budgets/quotas, context namespaces,
   skills, audit, notifications and the kill switch apply unchanged because they all key on the project id.
2. **Jobs in a workspace** have no repository, branch, worktree, push, merge or git flow verification. The worker
   creates an empty per-attempt **scratch directory** (`<root>/jobs/<jobId>/<attemptId>`, the same place and
   containment checks as a worktree) with `in/` (input files, read-only) and `out/` (deliverables). Same sandbox
   profiles, same cleanup and retention rules (success → deleted; failed/cancelled → retained, newest
   `retainFailed` kept).
3. **Inputs** are uploaded with the job (`POST /v1/jobs` → `inputs[]`, base64), bounded, secret-scanned and stored
   by the master (`job_inputs`). The worker fetches them over its authenticated session (control messages
   `JOB_INPUT_REQUEST` / `JOB_INPUT_DATA`, lease-fenced) and verifies size and SHA-256 before the agent starts.
   `continueFrom: <jobId>` copies a previous job's artifacts in as inputs.
4. **Outputs are artifacts**: files the agent writes under `out/` (bounded count/size, type allowlist, symlinks
   ignored, text redacted, binaries scanned) plus `summary.md` (the run's final summary). The worker streams them
   as sequenced, fenced `ARTIFACT_CHUNK` messages and commits each one with the existing `ARTIFACT_REF`; the
   master assembles, verifies SHA-256/size, re-redacts text and stores them (`job_artifacts`). They are listed,
   previewed and downloadable on the job page.
5. **Network.** A workspace has an egress policy `none | allowlist | web`:
   - `none`: model provider APIs only (the worker's `sandbox.egressAllow`; the same as repository jobs);
   - `allowlist`: model APIs + the project's `allowHosts` (≤ 64 `host[:port]`);
   - `web`: model APIs + **any public host on port 443** through the existing per-job egress proxy (CONNECT only,
     DNS resolved by the proxy, IP literals refused, loopback/private/link-local/metadata/CGNAT/ULA/NAT64 ranges
     refused after resolution, every decision logged).
   `genel` defaults to `web`; new workspaces default to `none`. Repository projects are unchanged.
6. **Placement.** Workspace projects are assigned to workers like other projects (p5-managed-workers), without
   repository URLs. The managed config document carries them in an additive `workspaces` map; a worker
   advertises feature `workspace-v1`. Workers without it never get a workspace job: placement reason
   `workspace_unsupported` (permanent; "update the worker").

## Shape

```
packages/protocol/src/master-messages.ts  JobSpec.repository optional, JobSpec.workspace {egress, allowHosts, inputs},
                                          exactly one of them; JOB_INPUT_DATA (control)
packages/protocol/src/worker-messages.ts  ARTIFACT_CHUNK (sequenced), JOB_INPUT_REQUEST (control)
packages/protocol/src/workspace.ts        limits, egress modes, artifact type allowlist, name rules (shared)
packages/protocol/src/worker-config.ts    WorkerConfigDocument.workspaces (optional), EffectiveConfigReport unchanged
packages/protocol/src/stream.ts           WorkerFeature `workspace-v1`
packages/scheduler/src/placement.ts       PlacementJob.workspace, reason `workspace_unsupported`
apps/master/migrations/0033_workspaces.sql  projects.kind, project_workspaces, job_inputs, job_artifacts,
                                          job_artifact_chunks, default project `genel`
apps/master/src/workspaces/service.ts     WorkspaceService: project kind + settings, input validation/scan/storage,
                                          input slices, chunk staging + verified commit, listing/content
apps/master/src/workspaces/routes.ts      settings, artifacts, inputs (download rules)
apps/master/src/orchestration/            inbox (ARTIFACT_CHUNK / ARTIFACT_REF ws-), session (JOB_INPUT_REQUEST),
                                          orchestrator (placement flag, egress at dispatch, recovery), routes (POST /jobs)
apps/worker/src/workspace/manager.ts      prepareScratch / releaseScratch / retention of scratch dirs
packages/agent-adapters/src/fake/         fake steps write-file / read-file / symlink (tests)
apps/worker/src/jobs/workspace-job.ts     inputs fetch, out/ collection (limits, types, redaction, scan), chunking
apps/worker/src/sandbox/{types,network,egress/*}  NetworkPolicy `web`, proxy `anyPublicHttps`, sidecar mode
apps/web                                  Projects (kind, workspace settings), composer (inputs upload),
                                          job page (artifacts + preview), "General" quick action
```

## 1. Protocol (additive in 1.0)

- `JobSpec.repository` becomes optional; `JobSpec.workspace?: { egress: 'none'|'allowlist'|'web', allowHosts?:
  string[≤64], inputs?: { inputId, name, mediaType, sizeBytes, sha256 }[≤10] }`. A spec must have exactly one of
  `repository` / `workspace` (refinement). Old workers would refuse a spec without `repository` at parse time,
  which never happens: the master only places workspace jobs on `workspace-v1` workers.
- `ARTIFACT_CHUNK` (worker → master, **sequenced**, job message): `{attemptId, epoch, artifactId, index, data}`
  with `data` base64 of ≤ 128 KiB. Idempotent on `(attemptId, artifactId, index)`. The worker sends all chunks of
  an artifact, then `ARTIFACT_REF {artifactId, name, mediaType, sizeBytes, sha256}` (existing message) which
  commits it. A worker whose outbox is full waits (backpressure) instead of dropping.
- `JOB_INPUT_REQUEST` (worker → master, control): `{attemptId, epoch, requestId, inputId, offset}`;
  `JOB_INPUT_DATA` (master → worker, control): `{attemptId, epoch, requestId, inputId, status: ok|refused|
  not_found, offset, data, eof}` with ≤ 192 KiB per answer. Only the holder of the job's live lease gets data
  (the same check as JOB_CREDENTIAL). Control messages: nothing is written to the master's durable outbox.
- `WorkerConfigDocument.workspaces?: Record<projectId, { egress, allowHosts? }>` — sent only to workers that
  advertise `workspace-v1` (a worker that predates it would strip the key and fail the document hash).
- Feature `workspace-v1`. CAPABILITIES `projects` (and `workerConfig.effective.projects`) include the workspace
  projects in effect, so the existing placement checks (`project_not_assigned`, `blocked_by_local_ceiling`,
  `project_not_in_worker_allowlist`) apply unchanged.

## 2. Master

### Data (migration 0033)

- `projects.kind text NOT NULL DEFAULT 'repository' CHECK (kind IN ('repository','workspace'))`.
- `project_workspaces (project PK → projects, egress, allow_hosts jsonb, updated_by, updated_at)`.
- `job_inputs (job_id, input_id, name, media_type, size_bytes, sha256, content bytea, source 'upload'|'artifact',
  source_job_id, created_at)`; PK `(job_id, input_id)`.
- `job_artifact_chunks (attempt_id, artifact_id, idx, data bytea, received_at)`; PK `(attempt_id, artifact_id,
  idx)` — staging, deleted when the artifact is committed (or by retention after 7 days).
- `job_artifacts (job_id, attempt_id, artifact_id, name, media_type, size_bytes, sha256, kind 'output'|'summary',
  redacted, content bytea, created_at)`; PK `(attempt_id, artifact_id)`.
- Default project `genel` ("General", `kind = workspace`, egress `web`); `ON CONFLICT DO NOTHING`.

### API (backwards compatible; documented in OpenAPI)

| Route | Who | Notes |
|---|---|---|
| `GET /v1/projects` | viewer+ | items gain `kind` |
| `POST /v1/projects` `{id, name, kind?, egress?, allowHosts?}` | admin, step-up | `kind` default `repository` |
| `GET /v1/projects/:id/workspace` | viewer+ | `{project, kind, egress, allowHosts, updatedAt, updatedBy}`; 409 `not_a_workspace` |
| `PUT /v1/projects/:id/workspace` `{egress, allowHosts}` | admin, step-up | audited `project.workspace.update`; managed workers re-resolved (cause `workspace`) |
| `PUT /v1/projects/:id/git` | admin | 409 `not_a_repository_project` for workspaces |
| `POST /v1/jobs` `{project, spec, priority?, inputs?, continueFrom?}` | operator+ | for a workspace: `spec.repository` refused (`spec.repository:not_allowed`), `spec.workspace` set by the master; `inputs[] {name, contentBase64}`; `continueFrom` = a job id readable by the caller whose artifacts become inputs. Response `job` gains `projectKind`. |
| `GET /v1/jobs`, `GET /v1/jobs/:id` | viewer+ | gain `projectKind` |
| `GET /v1/jobs/:id/artifacts` | viewer+ (`jobs.read`) | `{artifacts[], inputs[]}` metadata only |
| `GET /v1/jobs/:id/artifacts/:artifactId` | viewer+ | bytes; `?inline=1` only for text/markdown/csv/json and png/jpeg/gif/webp, otherwise `attachment`; `Content-Security-Policy: sandbox; default-src 'none'`, `X-Content-Type-Options: nosniff` |
| `GET /v1/jobs/:id/inputs/:inputId` | viewer+ | bytes, always `attachment` |

Request bodies of `POST /v1/jobs` are limited to 16 MiB (inputs ≤ 10 files, ≤ 5 MiB each, ≤ 10 MiB total).

### Inputs

Name: `[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,99}` with an allowlisted extension (the same table as artifacts). Text
types must be UTF-8 without NUL and are scanned with `scanText` (vendor prefixes, PEM, JWT, high-entropy
context values); images/PDF are checked for their magic bytes and their raw bytes scanned for the strong rules
only. A finding refuses the upload with `422 input_secret_detected` naming the file, rule and line — never the
value. Audit: `job.create` metadata gains `inputs` (count, bytes) and `continueFrom`.

### Dispatch and lifecycle

- `#placementJob` marks workspace jobs (`workspace: true`, no `repositoryRegistered`); candidate workers carry
  `workspaceSupported` from their `features`.
- `assignPayload`: `spec.workspace.egress/allowHosts` are re-resolved from `project_workspaces` at dispatch
  (a settings change applies to queued jobs); `pushResult` is false; git flow is never prepared.
- Result: workspace jobs never use git flow → `verification_passed_no_approval` as for other non-git-flow jobs.
- Recovery: a LOST workspace attempt that never started the runtime is retried; one that ran is **not** rerun
  blindly (web side effects cannot be verified) → `reconcile_fail` with reason "workspace attempt ran; continue
  from it manually" (ADR-0004 §5).
- Inbox: `ARTIFACT_CHUNK` is fenced like `LOG_CHUNK` (stale epochs refused); its `data` is stored in
  `job_artifact_chunks` and **stripped from the `worker_inbox` journal** (only sizes are journaled). Limits are
  enforced again on the master (`rejected: artifact_limit`). `ARTIFACT_REF` with an `ws-` id assembles and verifies
  the chunks (missing chunk / size / hash mismatch → `rejected: artifact_incomplete`, nothing stored), re-runs the
  master redactor on text, stores the artifact and deletes the staging rows.

## 3. Worker

- `JobRunner` detects `spec.workspace`. Preflight: the workspace port must support scratch (`prepareScratch`) and
  the project must be an allowed workspace project (managed: `document.workspaces`; local file:
  `workspace.scratch.projects`) — else declined `workspace_unsupported` / `workspace project not allowed`.
- **Egress ceiling** (local file, ADR-0015 §3): `workspace.scratch.enabled` (default true) and
  `workspace.scratch.maxEgress` (default `web`). Effective mode = min(job, panel document, ceiling) in the order
  `none < allowlist < web`; `allowlist` hosts are the job's hosts ∩ the document's hosts.
- Scratch: `WorkspaceManager.prepareScratch` (ids validated, component-wise creation, free-space check), `in/` files
  written 0444 after SHA-256 verification, `out/` 0700. `releaseScratch`: success → deleted after artifacts were
  queued; failed/cancelled → retained record `kind: scratch`, pruned with the other retained workspaces.
- Sandbox: `SandboxContext.sandboxDir` (new, optional) lets the runner use the attempt's sandbox dir for runtime
  state without a git view (container rw mount check, host runner scratch). Network policy: `allowlist` or the
  new `web` mode.
- Prompt: a fixed preamble tells the agent where inputs are, that deliverables go to `out/` (limits, allowed
  types) and that there is no repository. Web content is untrusted data (ADR-0010 authority order applies).
- Collection (`workspace-job.ts`): walks `out/` (no symlinks followed, depth ≤ 4, regular files only), applies the
  allowlist and limits (20 files, 5 MiB each, 15 MiB total; extras are skipped and listed in `summary.md`),
  redacts text with the job redactor (exact injected values + patterns), scans binaries for strong patterns and
  job secrets (a hit drops the file and notes it), then sends chunks and the commit. `summary.md` always comes
  last (redacted summary + skipped/dropped list).

## 4. Web

- Projects: create dialog with *kind* (repository / workspace) and, for workspaces, egress; a workspace's
  settings card edits egress and allowed hosts (admin, step-up); repository settings stay for repository
  projects only.
- Composer: for a workspace project, repository/branch fields are hidden and an inputs picker (files, limits
  shown) and an optional "continue from job" field appear.
- Job page: artifacts list (name, type, size), preview for markdown/text/CSV/JSON (escaped, never HTML) and images,
  download for everything; inputs listed.
- Image previews (p9-files-image-preview, 2026-10-17): `<img src="/api/jobs/:id/artifacts/:artifactId?inline=1">`,
  the same same-origin route the Outputs drawer uses. They were first rendered from a fetched `blob:` object URL,
  which the console CSP (`img-src 'self' data:`) refuses — live every preview was a broken image. Decision: keep the
  CSP as it is (no `blob:` in `img-src`) and load from the route, which already answers allowlisted raster types
  (`image/png|jpeg|gif|webp`, magic bytes checked at commit) with their own `Content-Type`,
  `Content-Disposition: inline`, `nosniff`, `Cross-Origin-Resource-Policy: same-origin` (needed under the console's
  COEP `require-corp`) and a `sandbox; default-src 'none'` CSP; the session cookie authorises it like any GET and
  `jobs.read` on the job's project applies. A failed load shows "could not be shown — download" instead of a broken
  icon. Security: no new directive, no client-side byte handling; an image is decoded only as an image (never a
  document of the console's origin). Tests: master integration (headers for all four types, Outputs read model),
  web unit (src is the route, no object URL), e2e `files-image-csp.spec.ts` (production build, master CSP + COEP,
  service worker blocked so the injected headers apply; `naturalWidth > 0` on the Files tab and in Outputs — the
  same spec against the old build fails with an `img-src` violation).
- Navigation: a "General" quick action in the jobs/composer area (bottom bar stays at five items, p5-nav-sections).

## 5. Security review

| Threat | Mitigation | Residual |
|---|---|---|
| Prompt injection from web content (ADR-0010) | Authority order unchanged: web text is data, never authorization; the agent can only write its scratch dir; no repository, no git credential, no push; secrets limited to the runtime's own credential and the job's explicit `secretRefs`; sensitive actions still need approvals | An injected page can steer the *content* of the deliverables and make the agent fetch other public URLs (exfiltration of what the agent knows: the prompt, inputs, its own outputs). Mitigation: don't put secrets in prompts/inputs (inputs are scanned), choose `allowlist`/`none` for sensitive work |
| Exfiltration through `web` egress | CONNECT only to public addresses on 443; IP literals, private/link-local/metadata/CGNAT/ULA/NAT64 refused after resolution (no rebinding: connects to the checked address); decisions logged per job | Any public HTTPS host is reachable by design; volume is not limited (only by job duration) |
| SSRF to the LAN / cloud metadata | Proxy refuses forbidden ranges; container jobs have no route except the proxy; macOS Seatbelt allows only the proxy port | Linux/Windows `host-restricted` cannot enforce egress (p3-sandbox residual) — the egress mode is then advisory; prefer `container` |
| Secrets in outputs | Text artifacts redacted on the worker (exact values + patterns) and again on the master; binaries scanned (strong patterns + exact values) and dropped on a hit | Compressed binary streams (e.g. PDF FlateDecode) are not inspected; formats outside the allowlist are never collected |
| Secrets in inputs | `scanText` on upload, refusal names rule + line only | Unknown-format secrets pass; inputs are visible to project viewers |
| Malicious artifacts (XSS, content sniffing) | Type allowlist (no HTML/SVG/JS); downloads `attachment` by default; inline only for text and raster images with `CSP: sandbox; default-src 'none'` + `nosniff`; the web preview never injects HTML | — |
| Disk/DB exhaustion | Input and artifact count/size bounds on both sides; staging chunks are bounded per attempt and expire; scratch dirs follow workspace retention | Without a storage policy artifacts are kept as long as the job (per-project retention and quota: p5-research-workspace-next) |
| Cross-attempt interference | Scratch path per attempt under `jobs/`, the same containment as worktrees; inputs written read-only | — |
| Duplicate side effects (ADR-0004) | Chunks and commits idempotent per `(attempt, artifact, index)`; lost-after-start attempts not rerun | — |
| Old workers | Feature-gated: no document key, no placement, no ASSIGN_JOB for workers without `workspace-v1` | — |

## Not in this change (backlog `p5-research-workspace-next`, `p5-research-workspace-hosts`)

- ~~Workflows (DAG runs) on workspace projects; schedules with inputs~~ — done in
  [p5-research-workspace-next](p5-research-workspace-next.md) (run files, upstream files, automations with files and
  continue-from).
- ~~Artifact retention separate from job retention, per-project artifact storage quotas~~ — done in
  [p5-research-workspace-next](p5-research-workspace-next.md).
- The artifact list's `redacted` flag reflects the master's pass; what the worker redacted is listed in
  `summary.md`.
- Verification on real hosts: container profile with the rebuilt egress-proxy image (web mode) on Linux, Seatbelt
  on macOS with web egress (unit/integration tests here use the in-process proxy and the fake runtime).

## Rollback

Feature-additive. Revert the commits; migration 0033 is additive (drop `job_artifact_chunks`, `job_artifacts`,
`job_inputs`, `project_workspaces`, `projects.kind` and delete project `genel` only if no job references it).
Workers without the feature ignore everything. A worker rollback leaves workspace jobs waiting with
`workspace_unsupported`.

## Operational metrics

Log events: `workspace inputs fetched`, `workspace artifacts collected` (counts, bytes, skipped, dropped),
`artifact committed` / `artifact rejected` (reason), egress decisions (`egress` lines with job id; `web` mode
denials are alarms worth watching). Count `workspace_unsupported` placements, `input_secret_detected` refusals.

## Tests

- protocol: JobSpec exactly-one rule, chunk/input schemas, document `workspaces`.
- scheduler: `workspace_unsupported`, managed workspace assignment without repository.
- master integration (`workspaces.test.ts`): workspace project + settings API (RBAC, step-up, audit), job with
  inputs → real JobRunner + fake adapter reads `in/`, writes `out/` → artifacts stored, listed, downloaded,
  inline rules; continue-from; quotas/kill switch on a workspace; egress policy delivered in ASSIGN_JOB and in the
  managed document; old worker → `workspace_unsupported`; secret input refused; repository projects unchanged.
- worker: scratch layout/containment/retention, out/ limits and types, symlink ignored, redaction and binary
  scan, egress mode `web` in the proxy (public allowed, private/metadata/IP literal refused, non-443 refused),
  ceiling intersection.
- web: Projects kind + workspace settings, composer inputs, job artifacts list/preview.
- rbac-matrix / route-coverage: new actions and routes.
