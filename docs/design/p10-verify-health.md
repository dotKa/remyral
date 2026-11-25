# p10-verify-health — automatic verification of a job's result, and a health check after every deploy

- **Task:** `p10-verify-health`. **Date:** 2026-10-18.
- **Owner request (approved):** "automatic verification step and post-deploy health check (screenshots, broken links)".
- **Decision:** [ADR-0035](../adr/0035-verification-gate-for-deploy-on-success.md) amends ADR-0030 for the gate mode
  (a pre-approved deploy waits for the job's verification; an admin can override it with a fresh authenticator code).
- **Builds on:** [p6-deploy-on-success](p6-deploy-on-success.md), [p8-uptime](p8-uptime.md) (the SSRF-guarded probe),
  [p8-orchestration](p8-orchestration.md) (master-created child jobs), [p6-outputs](p6-outputs.md),
  [p8-preview-tunnels](p8-preview-tunnels.md), [p5-machine-admin](p5-machine-admin.md) (tool inventory: the managed
  Playwright Chromium is reported as `playwright-chromium` and satisfies the `browser` requirement).
- **Migration:** 0077 (0075 / 0076 were taken by p10-backup-restore / p10-semantic-memory; renumber at merge if needed). **Worker release:** only for the chat path (`draft_job.verifyOnSuccess`
  lives in `@remyral/protocol`, served by the assistant host on a worker). The verifier itself is an ordinary job: no
  new worker code, no new protocol message.

## 1. Shape

```
 job created (composer / chat card / template / automation) ── "Verify when done": off | report | gate
   │   absent → the project's default (Project → Deploy → Verification); one job_verifications row per job
   ▼
 job SUCCEEDED ── tick step "verification" claims it (FOR UPDATE SKIP LOCKED) and runs outside the tick:
   1. master checks (deterministic, no worker):     site bundle → static link check of the bundle itself
                                                     docs (workspace .md files) → relative links + bounded
                                                     external links through the guarded probe
   2. verifier job (agent, role verify) when the checklist needs execution (build / lint / tests / browser):
        child job of the same project, created as the job's creator (re-authorised), runtime = the request's,
        else the project's verification runtime, else the job's; `requirements.tools: [browser]` for a site when
        a machine reports a browser; the master renders a FIXED checklist by output type (§3)
   3. verifier ended → its report (out/verification/report.json, or the repository verifier's
      `remyral-verification/` site bundle) is parsed as untrusted data, screenshots kept as job files
   ▼
 state passed | warned | failed | error  ── job page Verification card, badge, Outputs files, notification on failure
   ▼
 gate mode + deploy on success: the deploy-on-success tick only claims the deploy when the verification
 passed or warned (or an admin overrode it); otherwise the deploy waits with the reason (ADR-0035)

 ops action pages.deploy / coolify.deploy / *.rollback succeeded, or a preview tunnel became active
   ▼
 tick step "deploy-health": guarded probe (status, latency, TLS days, keyword) → same-origin crawl of the live
 site (bounded) → optional screenshot job on a machine with a browser → result on the ops action (Deploys),
 the Outputs site card (health dot + latest screenshot) → notification + chat note on failure → optional
 auto-rollback (project setting; policy-checked; production only with its own setting)
```

| Piece | Where |
| --- | --- |
| Modes, settings, report schema, limits | `apps/master/src/verify/model.ts` |
| Link extraction and classification (pure) | `apps/master/src/verify/links.ts` |
| Bounded same-origin crawler (injected fetch) | `apps/master/src/verify/crawler.ts` |
| Static site-bundle check, docs link check | `apps/master/src/verify/bundle-check.ts`, `docs-check.ts` |
| Verifier checklist (prompt) | `apps/master/src/verify/checklist.ts` |
| Verifier report parsing + screenshot extraction | `apps/master/src/verify/report.ts` |
| Job verification service (create, tick, gate, override, view) | `apps/master/src/verify/service.ts` |
| Post-deploy health service | `apps/master/src/verify/health.ts` |
| Project settings | `apps/master/src/verify/settings.ts` (`project_verify_settings`) |
| REST | `apps/master/src/verify/routes.ts` |
| Notifications | outbox topic `verify`, kinds `verify.failed`, `deploy.unhealthy` (`apps/master/src/verify/notify.ts`) |
| Guarded page fetch | `createProbe().page()` in `apps/master/src/uptime/probe.ts` (same guard as the monitors) |
| Gate in deploy on success | claim query of `DeployOnSuccessService.tick` (`apps/master/src/ops/on-success.ts`) |
| Console | job page Verification card; composer / templates / automations "Verify when done"; Project → Deploy "Verification & health"; Deploys health column + detail; Outputs site card health + screenshot |

## 2. Modes and where they come from

`off` (nothing), `report` (verify and report; never blocks), `gate` (verify; a pre-approved deploy on success waits
until the verification passed or warned). Gate without a deploy on success behaves like report (the card says so).

| Entry point | Field | Absent |
| --- | --- | --- |
| `POST /jobs` | `verifyOnSuccess: {mode, runtime?}` | the project's default mode |
| Chat `draft_job` card | `verifyOnSuccess: off\|report\|gate` | the project's default |
| Template defaults | `defaults.verify: off\|report\|gate` (composer prefill, template automations) | the project's default |
| Automation job target | `verifyOnSuccess: off\|report\|gate` (column `automations.verify_on_success`) | the project's default |
| Project | `Project → Deploy → Verification`: default mode, verifier runtime, test command | `off` |

Never verified: machine-admin jobs, sub-jobs (`job_subtasks`), verifier jobs themselves and health screenshot jobs
(created directly by the master, no row) — so a verification can never start another one.

## 3. The fixed checklist (by output type)

The output type is decided by the master when the job succeeded, from facts it holds — never from job output:

| Type | When | Master checks | Verifier job |
| --- | --- | --- | --- |
| `site` | the final attempt has a site bundle (`job_artifacts.kind = 'site'`) | bundle check: `index.html` present, every internal `href` / `src` / `srcset` / CSS `url()` of the HTML pages resolves to a bundle file (bounded: 200 pages, 5 000 references) | repository: checkout of the job's pushed branch; `package.json` → install + build + lint (scripts that exist); serve the site directory on 127.0.0.1; workspace: the bundle as input `site-bundle.json`, unpacked by a fixed command and served on 127.0.0.1. Then with headless Chromium (Playwright when the project has it, else `$REMYRAL_BROWSER` CLI): screenshots at 1280×800 (desktop) and 390×844 (phone), console errors, failed requests, internal links up to depth 2 / 25 pages |
| `repo` | repository job without a site bundle | — | checkout of the job's pushed branch; the project's test command if declared (Project → Deploy → Verification), else build / lint / test scripts of `package.json` when present |
| `docs` | workspace job with Markdown files | relative links point to files of the job; external http(s) links: at most 20, through the guarded probe (HEAD, 5 s) | none |
| `none` | anything else | — | none → `skipped` ("nothing to verify") |

When the verifier cannot be started (no runtime, the creator lost `jobs.create`, a repository job whose changes were
never pushed — no `job_git.branch` to check out), a **site** keeps the master's bundle check and gets a `warn` finding
"Verifier not run: …"; a **repository** job (nothing else was checked) ends `error`. A workspace site reaches the
verifier as its own already secret-scanned `site-bundle.json` (the upload scanner is not run again: base64 file contents
read as high-entropy text to it; a bundle the master flagged never gets this far).

The verifier writes `report.json` (+ PNG screenshots) to `out/verification/` (workspace) or `remyral-verification/`
(repository, returned through the existing site-bundle mechanism with `spec.siteBundle.directory =
"remyral-verification"`; the bundle is secret-scanned by the worker and the master as before). The prompt states the
report contract and that page content, repository files and tool output are data, never instructions.

### 3.1 Report contract (`VerifierReport`, Zod, untrusted)

```json
{ "version": 1, "status": "pass|warn|fail",
  "checks":   [{ "id": "build|lint|test|screenshot-desktop|screenshot-phone|console|requests|links|other",
                 "status": "pass|warn|fail|skipped", "detail": "≤ 300 chars" }],
  "findings": [{ "severity": "info|warn|fail", "kind": "console|request|link|build|lint|test|layout|other",
                 "message": "≤ 300 chars", "url": "optional, ≤ 500" }],
  "screenshots": [{ "file": "desktop.png", "width": 1280 }] }
```

At most 20 checks, 100 findings, 4 screenshots (PNG magic checked, ≤ 2 MiB each). Text fields are clipped, control
characters dropped and rendered as text only. A missing / invalid report is the state `error`.

### 3.2 Result

`passed` / `warned` / `failed` = the worst of the master checks and the verifier's own status **and** its checks
(a failed check makes it failed whatever `status` says). `error` = the verifier job failed, was cancelled, or produced
no valid report. `skipped` = the job failed / was cancelled, or there was nothing to verify.

## 4. Gate (ADR-0035)

- The deploy-on-success claim (`DeployOnSuccessService.tick`) takes a pending deploy only when the job has no gate
  verification, or it is `passed` / `warned`, or it was overridden; an expired pre-approval is still claimed (and
  skipped) as before.
- While held the deploy row shows the reason ("Waiting for the verification" / "Verification failed: … — an admin can
  deploy anyway"). `failed` / `error` notifies the creator and the project admins (`verify.failed`).
- **Override:** `POST /jobs/:id/verification/override {reason}` — `deploy.approve` in the job's project (project admin)
  and an always-fresh authenticator code; allowed while the gate holds (`waiting` / `checking` / `verifying` / `failed`
  / `error`). Audited `verify.gate.override`; the deploy then proceeds on the next tick with its own pre-approval
  checks unchanged.

## 5. Post-deploy health check

1. **Discovery** (tick step `deploy-health`, every tick): succeeded `pages.deploy`, `coolify.deploy`, `pages.rollback`,
   `coolify.rollback` actions finished in the last 30 minutes without a check, and preview tunnels that became `active`
   with a running connector in the last 30 minutes, of projects whose setting "Health check after deploy" is on
   (default **on**). One row per action / preview (unique).
2. **Probe** — `createProbe().http` (the uptime guard: http/https on 80/443/8080/8443, public addresses only, checked per
   hop, no credentials, fixed headers): GET, 200–399, ≤ 3 redirects, 10 s, the project's optional keyword. A failure
   is retried 3 times 20 s apart (the site may still be propagating) before it counts.
3. **Crawl** — `crawl()` from the final URL: same origin only (scheme + host + port of the start URL), `<a href>`
   pages up to depth 2 / 25 pages, plus their same-origin assets (`src`, `<link href>`) status-checked (≤ 100), 20 s
   budget, ≤ 512 KiB read per HTML page, 4 in parallel, through `createProbe().page()` (same guard). External links
   are counted, never fetched. 4xx / 5xx / network failures of pages or assets are findings with the referring page.
4. **Screenshots** — when the project allows it (default on), the preview is not protected, and a machine reports a
   browser: a screenshot job (verifier checklist type `live`) in the same project as the deploy's requester
   (re-authorised `jobs.create`); else "master-side link check only" with the reason. The job's screenshots become
   the Outputs site thumbnail.
5. **Result** — `passed` (probe ok, no broken page or asset), `warned` (probe ok but broken links / slow / TLS
   expires within 14 days / console errors from the screenshot job), `failed` (probe failed after retries, or the
   start page answered 4xx/5xx). Protected previews (Access) only check that Cloudflare answers (no redirect followed,
   no credentials): `passed` with the info finding "protected, content not checked".
6. **On failure** — notification `deploy.unhealthy` to the project's operators (critical for production) with a link
   to the Deploys entry, and a note into the deploy's chat thread (the deploy-on-success source thread or the ops
   action's `chatThreadId`).
7. **Auto-rollback** (Project → Deploy, admin, step-up; **off** by default; production needs its own second switch):
   only for a failed check of a `pages.deploy` / `coolify.deploy` that has a rollback, never for rollbacks or previews.
   Requested through `OpsService.rollback` as the system actor `deploy-health` with idempotency key `health-rb-<id>`;
   the project's deploy policy decides as for any request (a production rollback normally waits for an approval).
   Audited `deploy.health.rollback`.

## 6. Data (migration 0077)

| Table / column | Content |
| --- | --- |
| `project_verify_settings` | per project: default mode, verifier runtime, test command, health after deploy, screenshots, keyword, auto-rollback, auto-rollback production |
| `job_verifications` | per job: mode, runtime, source, creator, state, output type, verifier job, checks, findings, screenshots (job id + artifact id), summary, reason, override, times |
| `deploy_health_checks` | per ops action / preview: url, env, state, probe result, crawl summary, findings, screenshot job, screenshots, rollback action, attempts, times |
| `automations.verify_on_success` | the automation's mode (null = project default) |
| `notifications.kind` | + `verify.failed`, `deploy.unhealthy` |

Rows are deleted with their job / project / action (cascade). Screenshots are ordinary job files (5 MiB cap per file,
the workspace retention and quota apply; the repository verifier's files are stored with the same limits).

## 7. API

| Route | Action |
| --- | --- |
| `GET /jobs/:id/verification` | `jobs.read` |
| `POST /jobs/:id/verification/override` | `deploy.approve` (job's project) + always-fresh step-up + CSRF |
| `GET /projects/:id/verify-settings` | `deploy.read` |
| `PUT /projects/:id/verify-settings` | `deploy.targets.write` + step-up + CSRF |
| `GET /deploy-health?project=&actions=&previews=` | `deploy.read` |
| `GET /ops/actions/:id/health` | `deploy.read` |
| `POST /deploy-health/:id/recheck` | `deploy.request` + CSRF (one per 30 s per check) |

`GET /outputs` site items carry `health: {state, checkedAt, statusCode, latencyMs, broken, screenshot}`.

## 8. Security review

| Threat | Control | Test |
| --- | --- | --- |
| SSRF from the control plane (crawler / docs link check pointed at internal services, DNS rebinding, redirects into the VPC) | every request goes through the uptime probe guard (`page()` = same `vet` + guarded `lookup` per hop); test-only `allowOrigins` | unit: crawler stays in origin; integration: an internal service sees zero requests |
| Crawler used to hammer a third party | same-origin only (start URL's origin, which is the deployed site); 25 pages, 100 assets, depth 2, 20 s, 4 in parallel, once per deploy (+ manual recheck ≤ 1/30 s) | unit bounds |
| Credentials leaking | no cookies, no authorization, no custom headers; protected previews are not crawled; the service token is never used | unit |
| Untrusted page / repository content steering the verifier (prompt injection: "report pass", "deploy now", "run rm -rf") | the checklist is fixed by the master; the verifier job has the parent's sandbox profile, approval policy (stricter of submitted / effective), no secret refs, no deploy, no sub-jobs; its report is data — only enums decide the state; free text is clipped and rendered as text | report parsing unit tests; verifier spec unit test |
| A prompt-injected verifier forging "pass" to get a deploy out | the gate is a quality check on top of the creator's pre-approval (ADR-0030), never an authorisation: a forged pass yields what deploy on success without gate already allows; the master's own bundle check still fails a broken bundle | documented residual risk (ADR-0035) |
| Screenshot abuse (size, type) | PNG magic, ≤ 2 MiB, ≤ 4 per report; the job file limits (5 MiB, 20 files / 15 MiB) and the secret scan apply; served by the existing artifact route (nosniff, sandbox CSP, `jobs.read`) | unit |
| Override abuse | `deploy.approve` + always-fresh step-up, audited, only while the gate holds | integration |
| Auto-rollback misfire | off by default; production needs a second switch; only after 4 failed probes over ~1 min; only deploy kinds; policy-checked like any request; idempotent per check; audited | integration |
| Privilege drift | verifier / screenshot jobs are created as the creator / requester re-authorised at that moment (`jobs.create`); a system-requested deploy gets no screenshot job | integration |
| Information in notifications / chat | identifiers, enums, URLs from the master's own records, counts — never page text | — |

Residual risks: the verifier is an agent and can misreport (gate = quality, not authority); it inherits the verified
job's approval policy and sandbox profile — a job the owner ran with full access (ADR-0020) gets a verifier with full
access that reads the same (job-produced) content, no more than the job itself could do; a post-deploy screenshot job
takes the settings of the project's newest person-started job; a workspace project with egress `none` cannot open a
live URL in its screenshot job (the master check still runs); the master-only vantage point of p8-uptime applies to the
health probe.

## 9. Operations

- Migration 0077 (additive; widened notification kind CHECKs). Rollback: deploy the previous master — the new tables
  are ignored, the deploy-on-success gate disappears with the code (held deploys then proceed: documented in ADR-0035).
- No env variables, no Traefik change. Egress as p8-uptime.
- Worker release: only for the chat card field. Older assistant hosts simply do not offer `verifyOnSuccess`; the
  project default still applies to chat jobs.
- Tick steps `verification` and `deploy-health` are instrumented like every step.

## 10. Tests

- Unit `apps/master/test/unit/verify-links.test.ts` (extraction, classification, crawler bounds, same-origin, depth,
  page / asset limits, budget), `verify-model.test.ts` (report parsing, state combination, checklist, bundle check,
  docs check, verifier spec).
- Integration `apps/master/test/integration/verify-health.test.ts` (Postgres, fake sites over loopback with
  `allowOrigins`, fake worker = test-driven job transitions + artifacts): project default, report mode end to end with
  screenshots, gate holds the deploy, override with step-up, verifier failure → error, docs checks, health check after
  a Pages deploy (pass / broken links / down → notification + auto-rollback request), SSRF (internal service sees zero
  requests), recheck throttle, Outputs health + thumbnail, RBAC.
- Web `apps/web/test/verify-health.test.tsx`.

## 11. Platform report jobs never wait for a merge (p11-fixes-a, migration 0090)

**Found live:** in a project with git flow, the repository verifier (spec with `repository` + `siteBundle:
remyral-verification`) got a `job_git` row at dispatch like any repository job, so the worker committed and pushed its
report folder, git flow verified the branch and the verifier ended in **AWAITING_APPROVAL**. The tick only collected
verifiers in SUCCEEDED / FAILED / CANCELLED: the verification stayed `verifying` forever and a gated deploy on success
waited forever. The integration's verifier (p11-merge-pipeline) and the post-deploy screenshot job had the same shape.

**Fix:**

- Every platform report job — the job verification's verifier, the integration's verifier, the post-deploy screenshot
  job — is marked **report-only** in its creation transaction (`report_only_jobs`, purpose `verify` /
  `integration-verify` / `health`; master-written only, never from a request body). `GitFlowService.prepareDispatch`
  skips it: no `job_git` row → its assignment has no `pushResult` → the worker never commits or pushes; the report
  still comes back as the `site-bundle.json` artifact (packed from the worktree, independent of publishing) and the job
  ends **SUCCEEDED**. The integration no longer writes a `job_git` row for its verify job.
- Defence for verifiers that already went through git flow (created by an older master): the verification tick, the
  health tick and the integration treat a verifier in **AWAITING_APPROVAL** as a finished run — the report is read
  and the pointless merge gate is closed (system `cancel_requested`, reason "its report was collected; a verification
  branch is never merged"). FAILED / CANCELLED still mean "could not run" (`error`).
- Security: unchanged trust model — the report is still untrusted data; a report-only job has *fewer* side effects
  (no push). The marker cannot be set through the API, so it cannot be used to skip git flow for ordinary work.
- Tests: `verify-health.test.ts` "git-flow project: the repository verifier is report-only…" (fails on the old code:
  no marker, `job_git` created at dispatch; the AWAITING_APPROVAL verifier was never collected);
  `merge-pipeline.test.ts` asserts the real-worker integration verifier ends SUCCEEDED with no `job_git` row.
- Rollback: deploy the previous master; the table is ignored (verifiers then go through git flow again).
