# ADR-0048: Agents read their project's deploy logs; failed deploys start (bounded, opt-in) fix jobs

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** owner (2026-10-19: "deploy sonucuna erişebiliyor muyuz chatten veya job içinden? deploymentta
  sorun varsa fixlenmeli, loglara erişilebilmeli"); implemented by `p12-deploy-feedback`
- **Amends:** ADR-0028 §1 (what leaves the master: redacted deploy **logs**, never tokens, may reach agents of trusted
  jobs) and §6 (a job's agent may *request* a redeploy of its result), ADR-0038 §4 (the in-job tool channel carries the
  deploy tools; the redeploy request follows the same rules as `publish_site`), ADR-0035 (health results are readable
  by agents and fix jobs). Everything else of ADR-0028 / 0030 / 0035 / 0038 stays.
- **Related:** docs/design/p12-deploy-feedback.md (design + security review), ADR-0010 (untrusted content never
  authorises), ADR-0045 (OpenCode file relay), AGENTS.md rules 4, 7, 10, 11.

## Context
Deploys run on the master with master-held tokens (ADR-0028); a deploy on success (ADR-0030) runs after the job has
ended, so a failing deploy was never seen by the agent that could fix it, the chat could not read logs, and Coolify
application logs were never fetched. The owner wants deploy results and logs reachable from chat and from inside jobs,
and failures fixed. Logs are produced by the deployed application and the provider: they can contain secrets and
attacker-controlled text.

## Decision
1. **The master reads logs, read-only, and only for the project's own resources.** Coolify deployment logs and
   application runtime logs (`GET /applications/{uuid}/logs`, only for resources the project's deploy target resolves
   to at that moment, the control-plane deny-list re-checked, no request when refused), Cloudflare Pages deployment
   stages and build log, and the post-deploy health check. Every text passes the shared redactor and is tail-capped.
2. **People:** project operators (`deploy.request`) read logs through REST, the console and the chat tool
   `deploy_logs`; viewers keep the failure summary.
3. **Agents:** jobs with a trusted source created by a person get the in-job tools `deploy_status` / `deploy_logs` for
   their own project (every runtime with a tool channel), as that person re-authorised (`deploy.request`) on every
   call, rate-limited per job and audited. Log text is handed over fenced as data.
4. **A redeploy is only a request.** `request_redeploy` records a deploy on success **without a pre-approval** (the
   creator is the requester); it runs only after the job succeeded and the project's deploy policy decides —
   production always waits for a human approval.
5. **Fix jobs.** Any operator can start a fix job from a failure (composer prefill / chat card; the submission approves
   its deploy on success like ADR-0030). **Auto-fix** is per project, **off by default**, enabled by a project admin with
   step-up: one fix job per failed deploy / publish / health check of a job's result, created as the source job's
   creator re-authorised, at most `maxAttempts` (default 1) per chain; its redeploy is never pre-approved.

## Alternatives considered
- **Logs only for people (no agent access).** Rejected: the agent fixing a deploy is exactly who needs them; the risk is
  bounded to trusted jobs of people who may already deploy the same project.
- **Give the job a read-only Coolify token.** Rejected (ADR-0028 §1): no scoped, short-lived tokens exist; the master
  stays the only holder.
- **Run the deploy inside the job so the agent sees it fail.** Rejected: it would need tokens in the job and bypass the
  deploy policy.
- **Auto-fix pre-approved like the original deploy.** Rejected: a pre-approval is bound to one job (ADR-0030 §3); an
  automatic chain must not deploy production without a person.

## Consequences
- New residual exposure: application output that the redactor cannot recognise reaches project operators and agents
  of that project's trusted jobs. Documented in the design note §8.
- Migration 0095; worker release for the tools (`deploy-feedback-v1`) and the chat tools / prompt.
- Auto-fix costs jobs; bounded and opt-in.

## Verification
apps/master/test/integration/deploy-feedback.test.ts, preview-tunnels.test.ts (assignment + PREVIEW_REQUEST ops),
packages/agent-adapters/test/deploy-tools.test.ts, apps/worker/test/previews-supervisor.test.ts,
apps/web/test/deploy-feedback.test.tsx. **UNVERIFIED-LIVE** against the real Coolify instance and Cloudflare account.
