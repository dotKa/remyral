# ADR-0035: Automatic verification of a job's result, and a verification gate for "deploy on success"

- **Status:** Accepted
- **Date:** 2026-10-18
- **Deciders:** owner (approved 2026-10-18: "automatic verification step and post-deploy health check
  (screenshots, broken links)"); implemented by `p10-verify-health`
- **Amends:** ADR-0030 §4 (on success the master runs the pre-approved deploy) for jobs whose verification mode is
  `gate`. Everything else of ADR-0030 and ADR-0028 stays.
- **Related:** docs/design/p10-verify-health.md (design + security review), ADR-0010 (untrusted content never
  authorises), ADR-0031 (master-created child jobs), ADR-0028 (ops actions, rollback, deploy policy), p8-uptime (the
  SSRF-guarded probe), AGENTS.md rules 7, 10, 11.

## Context
Jobs that build a site or change a repository finish with whatever the agent claims; a deploy on success (ADR-0030)
then publishes it unattended. The owner wants an automatic check before and after: a verifier that builds, tests and
opens the site (screenshots, console errors, broken links), and a health check right after every deploy. The check is
done partly by an agent (the verifier job) whose output is untrusted, and partly by the master, which must not become
an SSRF or crawling tool.

## Decision
1. **"Verify when done" per job: off | report | gate.** Set on the composer, a chat card, a template or an automation;
   absent → the project's default (Project → Deploy, admin, step-up; default off). One `job_verifications` row per job,
   written in the job's creation transaction. Sub-jobs, machine-admin jobs and verifier jobs are never verified.
2. **After success** the master runs deterministic checks on what it holds (the site bundle's own links; Markdown
   links of documents, external ones only through the uptime guard) and, when the checklist needs execution, creates a
   **verifier job**: an ordinary job of the same project, created as the job's creator re-authorised at that moment,
   with a checklist the master renders (never from job output), the parent's sandbox profile, approval policy and
   source trust, no secret references, no deploy, no previews, a capped time limit and `role: verify`; it runs on a
   machine that reports a browser when one exists. Its `report.json` is parsed as data; only enums decide the state;
   screenshots are PNG-checked job files. The result is the worst of the master's checks and the verifier's checks.
3. **Gate.** For a job with `gate` and a pre-approved deploy on success, the deploy-on-success tick claims the deploy
   only when the verification `passed` or `warned` (or was skipped because there was nothing to verify), or a project
   admin **overrode** it (`deploy.approve` in the job's project + an always-fresh authenticator code, audited
   `verify.gate.override`). Until then the deploy waits with the reason; the creator and the project admins are told
   when the verification fails or cannot run. The 8-day expiry of the pre-approval still applies.
4. **Post-deploy health check** after every successful Pages / Coolify deploy or rollback and every preview tunnel that
   became active (project setting, default on): the uptime probe (same SSRF guard), a bounded **same-origin** crawl of
   the live site through that guard, optionally a screenshot job on a machine with a browser; results on the ops action
   and the Outputs site card; `deploy.unhealthy` + a chat note on failure.
5. **Auto-rollback** is opt-in per project (off by default; production needs a second switch), only for a failed
   check of a `pages.deploy` / `coolify.deploy` that is still the newest deploy of its site, requested through the ops
   service as the system actor `deploy-health` — the project's deploy policy decides as for any request.

## Alternatives considered
- **A deterministic Playwright runner built into the worker** (new job kind, no agent). Rejected for now: a new
  protocol message and worker release for every OS, a browser driver dependency in the worker, and no build / test
  step; the agent verifier reuses jobs, placement (`requirements.tools: browser`), artifacts and approvals as they are.
  The master's own deterministic checks cover what can be checked without executing anything.
- **Let the verifier's word authorise the deploy.** Rejected (ADR-0010): the gate only ever *withholds* a deploy the
  creator already pre-approved; a forged "pass" yields at most what deploy on success without a gate allows today.
- **Crawl from workers.** Rejected for the health check: the master already holds the guarded probe and the result
  belongs to the ops action; workers add only the screenshots.

## Consequences
- Migration 0077 (settings, verifications, health checks, automation column, two notification kinds).
- Verifier and screenshot jobs cost what a short job costs; they count against budgets and quotas like every job.
- A gate-held deploy can wait up to the pre-approval's expiry; an admin can release it.
- Rolling back the master removes the gate (held deploys then proceed on the old code's rules) — documented in the
  design note's operations section.
- The chat card field needs a worker release (assistant host); everything else is master + web.

## Verification
apps/master/test/unit/verify-links.test.ts, verify-model.test.ts (extraction, classification, crawler bounds,
same-origin, report contract, state rules, checklist, bundle / docs checks, verifier spec);
apps/master/test/integration/verify-health.test.ts (report mode with screenshots, project default, docs, gate holds /
override with step-up / passes with a repository verifier, health after a Coolify deploy with broken links, down →
notification + auto-rollback, SSRF refusal with zero requests, recheck throttle, Outputs health); rbac-matrix
(new routes); apps/web/test/verify-health.test.tsx. **UNVERIFIED-LIVE:** a real verifier run with Playwright Chromium
on a worker (desktop-pc) and a health check of a real Pages / Coolify deploy.
