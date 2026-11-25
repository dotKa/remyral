# ADR-0038: One approval for "publish on a domain" — the pre-approved publish bundle, DNS run-at-once for own Pages CNAMEs, and agents asking to publish

- **Status:** Accepted
- **Date:** 2026-10-18
- **Deciders:** owner (2026-10-18: "bu işlemleri de agent kendisi yapması gerekiyordu. istediğimizde tamamen
  agent yapabilmeli" → "yap tamamdır"); implemented by `p10-publish-bundle`
- **Amends:** ADR-0028 §3 (policy: DNS changes may run at once for CNAMEs to the project's own Pages projects; a bundle
  is decided by its strictest step) and §6 (a job's agent may ask to publish its own result, as the job's creator),
  ADR-0030 (deploy on success may carry the bundle; an agent's request is recorded without a pre-approval), ADR-0032
  (the in-job tool channel `PREVIEW_REQUEST` carries `publish`), ADR-0037 (an upload is published with the bundle).
  Everything else stays: master-held tokens, typed ops actions resolved from the project's configuration, protected
  records and control-plane refusals, secret-scanned bundles, idempotency, rate limit, audit, rollback.
- **Related:** docs/design/p10-publish-bundle.md (design + security review), ADR-0009 (step-up), ADR-0010 (untrusted
  content never authorises), AGENTS.md rules 7, 10, 11.

## Context
Publishing a finished static site on `site.example.org` took four separate approvals — create the
Pages project, deploy to production (with a code), attach the domain, write the CNAME — because only a job's own
deploy is pre-approved by deploy on success (ADR-0030). The owner wants an agent (the chat assistant, or the job's
own agent) to be able to do all of it, with at most one human decision, and none when the project says so.
AGENTS.md rule 10 still requires a clearly defined human approval policy for deployments.

## Decision
1. **The publish bundle is one ops action** (`pages.publish`, migration 0084): create the Pages project if it is
   missing (only a name new in the account; kept as a further Pages project; the target is never replaced) → deploy a
   succeeded job's result or an uploaded site (preview / production) → attach a custom domain → write its CNAME in an
   allowed zone. It is planned as a whole (one diff, every step with its own decision, one plan key over all steps'
   facts) and decided by its **strictest step**; when any approval is needed and production or a DNS write is
   involved, it needs **approval with an always-fresh code**.
2. **Approved once.** After the approval (or a pre-approval at creation — composer, chat `draft_job`, automation —
   satisfying the same level with the creator's permission and code, ADR-0030) each step runs as its own ordinary
   ops action **pre-approved by the bundle** (decided by the bundle's approver, reason "Approved with its publish
   bundle"), linked by `source.publishBundle`, audited per step. Before every step the master re-checks the approver
   (`deploy.approve`) and the requester (`deploy.request`), re-plans the step and refuses it when its planned facts
   changed (`stale`: other files / project / environment; another DNS record; a different zone); the step's own plan
   re-checks protected names, control plane, allowed zones, secret flags. A failed or refused step stops the chain and
   notifies; a policy stricter than at the approval makes that step wait for its own approval.
3. **DNS "Run at once"** (`policy.dnsChange = auto`) exists only for creates/updates of **CNAME records pointing at the
   `pages.dev` name of one of the project's own Pages projects** inside its allowed zones. Every other DNS change keeps
   approval; deletes keep approval + step-up; protected records stay refused. **Production deploys keep at least an
   approval** — at once only through a pre-approval (bundle / deploy on success with the project switch).
4. **Agents may ask.** The chat assistant drafts the bundle (`draft_job.deployOnSuccess` publish fields;
   `draft_deploy` `pages.publish`) — a human confirms. A job's own agent may call `publish_site` (in-job tool, worker
   feature `site-publish-v1`, over the job's live lease): only for trusted-source jobs created by a person (that person
   is the requester, re-authorized now and when it runs), recorded on the job without a pre-approval, executed only
   after the job **succeeded**, as one `pages.publish` the policy decides — by default one human approval; none only
   when the project set every step involved to run at once (never production). A request found in data is data.
5. **Provider failures are 424** (not 502, which the proxy in front of the console replaces) with the provider's
   message and the missing token permission for DNS; Test connection probes DNS read per allowed zone.

## Alternatives considered
- **Keep four cards** — what the owner rejected.
- **One action that performs all provider calls itself** — loses the per-step audit trail, the existing executors,
  health check, rollback and status polling of each kind; children reuse them unchanged.
- **Let agents call deploy kinds directly** — every kind would need its own agent policy; the bundle gives agents one
  narrow, reviewable request with the human approval in one place.
- **DNS auto for any record** — would let an approval-free path repoint arbitrary names; limited to the project's own
  Pages CNAMEs.

## Consequences
- AGENTS.md rule 10 holds: one explicit approval (or pre-approval with permission and code) covers exactly the steps
  shown; production never runs without one; the run-at-once path is the project admin's explicit policy, limited to
  preview deploys, Pages projects and own-Pages CNAMEs.
- A project with every step at "run at once" lets a trusted job's agent publish previews on its allowed zones
  unattended (owner's choice; documented in the console help and the Turkish guide).
- Worker release needed for the chat fields / prompt and for `publish_site`; master + web for the rest.

## Verification
apps/master/test/unit/ops-policy.test.ts (DNS auto matrix, bundle decision);
apps/master/test/integration/publish-bundle.test.ts (one approval with a fresh code runs create → production deploy →
domain → CNAME as linked pre-approved children; existing names refused; failure in the middle stops; changed
precondition refused; stale before approval; run-at-once limits; 424 with the DNS hint; Test connection DNS probe;
chat `draft_deploy pages.publish`; no token in any body); apps/master/test/integration/deploy-on-success.test.ts
(chat `draft_job` publish fields pre-approved with a code; the agent's request → one approval on success);
apps/master/test/integration/preview-tunnels.test.ts (assignment flag, `publish` op); protocol / adapters / worker
tests of the tool; web tests. **UNVERIFIED-LIVE** against the real Cloudflare account.
