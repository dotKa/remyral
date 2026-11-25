# ADR-0030: Pre-approved "deploy on success" — the job creator's submission approves the deploy

- **Status:** Accepted — extended by [ADR-0038](0038-pre-approved-publish-bundle.md) (deploy on success may carry
  the publish bundle: Pages project, domain, CNAME; an agent's request is recorded without a pre-approval)
- **Date:** 2026-10-16
- **Deciders:** owner (2026-10-16: "iş bitince başarılıysa otomatik deploy etsin bana bilgi versin. bunu
  engellemeyelim"); implemented by `p6-deploy-on-success`
- **Amends:** ADR-0028 §3 (policy), §6 (who may request) and §8 (automations / workflows) for one path: a job created
  with "deploy when done". Everything else of ADR-0028 stays — master-held tokens, typed ops actions, targets
  resolved from the project's configuration, protected records and control-plane refusals, secret-scanned site
  bundles, idempotency, rate limit, audit, rollback.
- **Related:** docs/design/p6-deploy-on-success.md (design + security review), ADR-0009 (step-up), ADR-0010
  (untrusted content never authorises), ADR-0018 (chat writes are draft cards), ADR-0024 (automations), AGENTS.md
  rule 10.

## Context
ADR-0028 lets a human request a deploy of a **finished** job (console card, chat draft, or a preview deploy by an
automation / workflow step); production always waits for an approval with a fresh authenticator code, and the chat
assistant told users that "deploy it when it is done" was impossible. The owner wants to start a job that builds HTML
or a site, and get the live link automatically when it succeeds — without a second card. AGENTS.md rule 10 still
requires a clearly defined human approval policy for deployments.

## Decision
1. **The approval moves to job creation.** A job (composer `POST /jobs`, a confirmed chat `draft_job` card, or an
   automation's job target when the automation is saved) may carry `deployOnSuccess = {target: pages | coolify, env:
   preview | production, directory?}`. The master checks, at that moment, what the deploy policy would ask for the
   deploy and requires the creator to satisfy it **now**: preview auto → `deploy.request`; preview approval →
   `deploy.approve`; approval with step-up → `deploy.approve` + an always-fresh TOTP. A refusal creates no job.
2. **Production is opt-in per project.** `policy.autoDeployProductionOnSuccess` (Project → Deploy, project admin,
   default **off**). Only with it on may a job deploy to production on success, and the creator then needs
   `deploy.approve` and the step-up `productionDeploy` names (default always-fresh) at creation.
3. **The pre-approval is a record, bound and single-use.** One `job_deploy_on_success` row per job (migration 0058):
   job id, project, target kind, environment, target snapshot, the level covered, approver = creator, approval and
   step-up times, channel, source, an 8-day expiry. Audited `ops.preapproval.create` / `ops.preapproval.finish`. Reruns
   and copies of a spec never inherit it (no row → no deploy).
4. **On success the master runs it without a card.** An orchestrator tick step re-checks (creator active and still
   allowed; the production switch still on; the configured target equal to the snapshot), takes the job's own site
   bundle (final attempt; flagged by the master's scan → refused; none → failed), binds the ops action to that
   bundle's SHA-256, and requests the ops action as the creator with the pre-approval. When today's policy decision
   is covered, the action is stored as decided by the creator ("Pre-approved at job creation"), audited
   `ops.action.approve` (`preApproved: true`) and executed at once. A stricter policy than at creation → the action
   waits for an approval like any other; refusals stay refusals. Failed or cancelled jobs never deploy.
5. **The creator is told.** A message in the originating chat thread (with the live URL), the job page's Deploy card,
   and a console notification (`deploy.succeeded` / `deploy.failed`, through the user's in-app / email / webhook
   channels).
6. **Untrusted content still cannot deploy.** Only the creator's `{target, env, directory}` is input; the real target
   comes from the stored configuration; a job's output can only fill the secret-scanned bundle of the fixed Pages
   project. Untrusted sources (fork pull requests, outside authors; `sourceTrust` ≠ trusted) never get a deploy on
   success. The assistant only drafts; the human confirms the card.

## Alternatives considered
- **Keep the second card after the job** — what the owner explicitly rejected ("bunu engellemeyelim").
- **An automation chain "job → deploy"** — the deploy target of ADR-0028 phase 2 cannot publish a job's site and
  would still need a card for production; it also loses the binding to one job's bundle.
- **Store the deploy request in `JobSpec`** — the spec travels to workers and is copied by reruns / continue-from;
  the authorization must not travel with it. The spec only gains the `siteBundle` it already supports.

## Consequences
- AGENTS.md rule 10 holds: the policy is the creator's explicit, permission- and step-up-checked approval at
  creation, with the project switch for production; every step is audited.
- A preview deploy of whatever a trusted job built runs unattended (as ADR-0028's preview auto); a production
  pre-approval can be up to 8 days old when it runs (owner decision; the switch is re-checked and can be turned off).
- The chat path needs a worker release (the `draft_job` field and prompt rule 15 live in the assistant host's
  packages); everything else is master-only.

## Verification
apps/master/test/unit/deploy-on-success.test.ts (levels, coverage, permissions, spec rewrite, snapshot, live URL);
apps/master/test/integration/deploy-on-success.test.ts (composer preview → Pages at once; production gate, approve
right, always-fresh step-up, pre-approved execution; switch off / target changed / creator demoted → refused; failed
job → skipped; flagged / missing bundle; stricter policy → card; Coolify; chat draft → confirm → message in the
thread; automation job target; replay; project-scoped read). **UNVERIFIED-LIVE** against real Coolify / Cloudflare
like ADR-0028.
