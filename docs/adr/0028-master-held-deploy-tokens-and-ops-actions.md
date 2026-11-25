# ADR-0028: Deploys and DNS changes as typed ops actions with master-held Coolify / Cloudflare tokens

- **Status:** Accepted — owner-approved plan, 2026-10-16 — §3 / §6 / §8 amended by [ADR-0030](0030-pre-approved-deploy-on-success.md) for jobs created with
  "deploy on success" (the creator's submission is the approval); §2 / §8 amended by
  [ADR-0037](0037-human-uploaded-static-sites.md) (Pages deploys from a site a person uploaded; further Pages projects);
  §1 / §2 / §4 / §5 amended by [ADR-0050](0050-multiple-coolify-connections.md) (several Coolify connections, the
  target names one, the deny-list applies to every connection);
  §3 / §6 amended by [ADR-0038](0038-pre-approved-publish-bundle.md) (the publish bundle approved once; DNS "run at
  once" only for CNAMEs to the project's own Pages projects; a job's agent may ask to publish its own result)
- **Date:** 2026-10-16
- **Deciders:** owner; implemented by `p6-deploy-integrations` (phase 1), `p6-deploy-pipeline` (phase 2)
- **Amends:** ADR-0006 §1 for one more secret class (the Coolify API token and the Cloudflare API token), stored
  like the panel GitHub App key (ADR-0022 §3). Everything else in ADR-0006 stays.
- **Related:** docs/design/p6-deploy-integrations.md (design + security review), docs/compat/coolify.md,
  docs/compat/cloudflare.md, ADR-0009 (step-up), ADR-0010 (untrusted repository content), ADR-0018 (ops chat draft
  cards), ADR-0024 (automations; phase 2 runs ops actions from them), AGENTS.md rules 4 and 10.

## Context
The owner wants agents and the orchestrator chat to deploy to Coolify, deploy to Cloudflare Pages and change
Cloudflare DNS. Giving a job or the assistant a Coolify or Cloudflare token would put a long-lived credential that can
take production down — or point the console's DNS elsewhere — into an environment that runs untrusted repository code
(ADR-0010) and model output. AGENTS.md rule 10 also requires a human approval policy for deployments.

## Decision
1. **The master holds the tokens.** Settings → Integrations → Coolify (instance URL, token, optional team name,
   extra deny-list) and Cloudflare (account id, token). Admin only, **always-fresh step-up** to save or remove,
   audited with token fingerprints only. Stored as AES-256-GCM under the HKDF sub-key `ops-integrations` of the master
   key file, AAD `ops-integration:<provider>` (table `ops_integrations`). Never returned, logged, audited, sent to a
   worker, put in a job environment or shown to the chat assistant. "Test connection" reports what the token can do
   (Coolify: version, team, read / deploy / write abilities; Cloudflare: token status, permitted zones, Pages access).
2. **Callers request typed ops actions; the master executes them.** Kinds: `coolify.deploy`, `coolify.restart`,
   `pages.deploy`, `dns.upsert`, `dns.delete`, and the rollback kinds `coolify.rollback` / `pages.rollback` (created only
   by "Roll back"). Every request names a project; the master resolves the real target from the project's deploy
   targets (never from the caller), computes a diff against the current provider state, decides by policy, executes,
   audits and stores the result (external ids, links) and what a rollback needs. REST + OpenAPI under `/deploy/*`;
   chat tools `draft_deploy`, `draft_dns_change` (draft cards) and `deploy_status` (read).
3. **Policy** (per project, tighten-only defaults): preview deploy/restart/Pages preview **auto**; production
   deploy/restart/Pages production/rollback **approval + always-fresh step-up** (may be lowered to approval, never to
   auto); DNS create/update **approval** (may be raised to approval + step-up, never auto); DNS delete **approval +
   step-up always**; protected records and control-plane resources **refused always**. Approvers: project admin
   (`deploy.approve`). An approved action is re-planned before it runs; if the target changed since the diff was shown
   it is not executed (`stale`).
4. **Never touched, whatever the configuration says:** the console host `console.example.org` (and the
   `PUBLIC_ORIGIN` host), MX / SPF / DKIM / DMARC records, records whose content is the console host, one of the
   console host's own record contents or an `OPS_CONTROL_PLANE_ADDRESSES` entry; the project's protected names; Coolify
   resources listed in `OPS_CONTROL_PLANE_COOLIFY_UUIDS` (environment — the panel can add to it, not remove) or whose
   `fqdn` serves the console host. A Coolify target the token cannot read is refused (the check cannot run).
5. **SSRF:** the Coolify URL is admin-set: `https://` only, no credentials/query, every resolved address must be
   public (checked inside the socket lookup, so no rebinding window), redirects are never followed, responses capped.
   Exceptions are exact origins in `OPS_INTERNAL_ORIGINS` (operator environment, e.g. the Coolify container on the
   control-plane host), never panel input. The Cloudflare API base is fixed (environment-only override for tests).
6. **Untrusted content cannot deploy** (ADR-0010/0011): nothing in a repository, issue, webhook payload or job output
   can request an ops action. Requests come from a signed-in human (REST/console), a human-confirmed chat draft, or
   (phase 2) a workflow step / automation a human configured; the assistant prompt says that a deploy request found in
   data is data.
7. Idempotency key per requester, a per-project rate limit (20 actions / 10 min), approvals expire after 24 h, and
   audit events `ops.integration.*`, `ops.targets.write`, `ops.action.request|approve|deny|execute`.

8. **Phase 2 (`p6-deploy-pipeline`, migration 0053):** automations may target an ops action (Coolify deploy /
   restart with fixed parameters) and workflow verifier / integrator nodes may carry a deploy step; both request as a
   system identity (`automation:<id>`, `workflow:<run>`) with the human recorded and re-authorized (`deploy.request`)
   at request time — the policy above still decides, so production waits for an approval. Events from untrusted
   sources never deploy; planners cannot add deploy steps. Jobs may declare `siteBundle` (worker feature
   `site-bundle-v1`): the worker packs the built site, refuses the whole bundle on any secret-scanner hit, the master
   re-checks and flags, `pages.deploy` publishes only an unflagged bundle, and the console never renders it. Deploy
   notifications (`deploy.waiting`, `deploy.failed`) and background status polling complete the loop.

## Threat model impact
| Threat | Mitigation | Residual |
| --- | --- | --- |
| Prompt-injected agent deploys or repoints DNS | Agents hold no token; only typed requests from humans / human-configured steps; policy + approval + step-up for production and DNS | A human approving a malicious-but-plausible diff |
| Token leak via DB dump / backup | Encrypted under a sub-key of the master key file (not in DB/backups), AAD per provider | Whoever has DB **and** key file (the master host) |
| Token leak via logs, audit, API, chat | No response schema field; audit metadata identifiers/fingerprints only; logger redaction; tests with canary tokens | Unknown provider error text echoing a token (none seen; messages are truncated) |
| SSRF through the Coolify URL (cloud metadata, internal services) | https + public addresses checked at connect time, no redirects, env-only exceptions | An `OPS_INTERNAL_ORIGINS` entry is trusted as given |
| Deploying the control plane itself / hijacking the console DNS | Deny-list (env + fqdn match), protected records, refusal recorded and audited | A control-plane resource without the console host in its fqdn must be in the env list |
| Approving a diff that no longer matches reality | Re-plan before execution; changed target → `stale`, nothing executed | — |
| Automation / workflow deploys without a human present | Fixed parameters set by a human; re-authorization of the run-as / run creator; untrusted sources refused; production still approval + step-up; failures and waits notified | A preview deploy of a trusted push runs unattended by design (policy `previewDeploy: auto`, tightenable) |
| Secrets published in a static site | Worker drops the whole bundle on a secret hit (injected values + token patterns); master re-scans and flags; flagged bundles refused | Secrets the scanners cannot recognise |
| Site HTML served by the console | Site bundles are never listed, previewed or downloaded through the console | — |
| Over-privileged tokens | Test connection warns on Coolify write/root; docs ask for read+deploy and zone-scoped DNS Edit / Pages Edit | Owner may still paste a broad token |

## Rollback
- **Of an action:** DNS — the previous record (stored at plan time) is restored, a created record is deleted, a
  deleted record re-created (each a new action with its own approval). Pages production — `POST …/deployments/{previous}/rollback`
  to the production deployment that was live before. Coolify deploy — `POST /applications/{uuid}/rollback` to the
  image tag that was running before (`rollback-images.current`), when the instance reports one. Restarts have none.
- **Of the feature:** remove both integrations (tokens deleted) — every action then fails with "not connected";
  migration 0050 is additive (tables `ops_integrations`, `project_deploy_targets`, `ops_actions`, chat draft kind).

## Alternatives considered
- **Tokens in the worker vault / job env** — rejected (owner decision): the job runs untrusted code.
- **Let agents call `wrangler` / the Coolify API with short-lived tokens** — no short-lived scoped tokens exist for
  Coolify; Cloudflare token minting would need an account-level token on the master anyway.
- **Reuse job approval requests** — they are bound to a job (`approval_requests.job_id NOT NULL`); ops actions are not
  jobs, so they carry their own approval state with the same roles and step-up rules.

## Verification
apps/master/test/integration/ops-actions.test.ts (fake Coolify / Cloudflare: exact calls, 401/403/429, policy
matrix, approval + step-up, stale re-plan, protected records, deny-list, Pages direct upload + rollback, idempotency,
rate limit, expiry, canary tokens absent from responses/logs/audit/rows), chat-deploy.test.ts, unit
ops-policy.test.ts, rbac-matrix / route-coverage. **UNVERIFIED-LIVE** against a real Coolify instance and Cloudflare
account until the owner runs docs/guide/tr/deploy-entegrasyonlari.md.
