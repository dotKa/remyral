# p10-publish-bundle — publish a site onto a custom domain with ONE approval

- **Task:** `p10-publish-bundle`. **Date:** 2026-10-18.
- **Owner decision (2026-10-18):** "bu işlemleri de agent kendisi yapması gerekiyordu. istediğimizde tamamen agent
  yapabilmeli" → "yap tamamdır" — the agent should have done these steps itself; when we want, an agent must be able
  to do all of it. Context: publishing a static site on `site.example.org` took **four** separate
  approvals (`pages.create_project`, `pages.deploy` production with a code, `pages.add_domain`, and the CNAME DNS
  write), because only a job's own deploy is covered by the one-time pre-approval of deploy on success (ADR-0030).
- **Decision:** [ADR-0038](../adr/0038-pre-approved-publish-bundle.md) (amends ADR-0028 §3 / §6, ADR-0030, ADR-0032,
  ADR-0037).
- **Builds on:** [p6-deploy-integrations](p6-deploy-integrations.md), [p6-deploy-on-success](p6-deploy-on-success.md),
  [p6-pages-create](p6-pages-create.md), [p10-site-upload](p10-site-upload.md),
  [p8-preview-tunnels](p8-preview-tunnels.md) (the in-job tool channel).
- **Migration:** 0084 (ops kind `pages.publish`; `job_deploy_on_success.publish`, covers `none`, via `job`).
- **Worker release:** needed for the chat path (`draft_job.deployOnSuccess` fields, `draft_deploy` action
  `pages.publish` and prompt rule 15 live in `@remyral/protocol` / `@remyral/agent-adapters`, served by the worker's
  assistant host) and for the in-job tool `publish_site` (worker feature `site-publish-v1`). Everything else —
  the bundle, the policy, the upload card, the composer, automations, the fixes — is master + web only.
- **Live status:** UNVERIFIED-LIVE — every Cloudflare call ran against `apps/master/test/helpers/fake-ops.ts`.

## 1. The publish bundle

A **publish bundle** is one ops action of the new kind **`pages.publish`** that stands for the chain

1. **create** the Pages project if it is missing (Direct Upload, no repository) — only with `createIfMissing`, and
   only a name that is new in the Cloudflare account; it is added to the project's further Pages projects
   (`pagesProjects`), the Pages target is never replaced;
2. **deploy** a job's result (site bundle / output files) **or** an uploaded site (`uploadId`) to preview or
   production;
3. optionally **attach a custom domain** to that Pages project;
4. **write its CNAME** (`domain → <project>.pages.dev`, proxied) when the domain lies in an allowed zone of the
   project and `dns` is `auto`.

The bundle is planned (one diff with every step), decided by policy (the strictest step — §3), approved **once**
(or pre-approved at creation — §2), and then each step runs as its own ordinary ops action (child) with **no further
approval**: the child is requested with the bundle's approval as a pre-approval (`preApproved`, ADR-0030 mechanism)
and re-checked at execution. Children carry `source.publishBundle = <bundle id>` and `source.step`; the bundle's
`result.steps[]` links them. The existing ops pipeline does everything else (audit, notifications, health check of
the Pages deploy, rollback of each child).

```
 request (REST / upload card / chat card / deploy on success / agent tool)
   │  pages.publish {jobId|uploadId, env, pagesProject?, createIfMissing?, domain?, dns?}
   ▼
 plan: one diff with steps [create?] [deploy] [domain + dns?] · plan key over all steps' facts
 policy: strictest step (§3) · approval with step-up when production or DNS is involved
   │  auto → runs · approval → ONE approval (always-fresh code when it says so) · pre-approved → runs
   ▼
 execute = advance the chain (now, then on every ops-deploying poll)
   step i: re-check approver + requester, request child (preApproved = the bundle's approval,
           precondition = the step's planned facts) ── refused / failed → bundle failed, chain stops, notify
           child succeeded (deploy: Cloudflare says success; domain: attached + CNAME written) → step i+1
   all steps done → bundle succeeded (links: deployment URL, https://<domain>)
```

### 1.1 Parameters (`pages.publish`, strict)

| Field | Meaning |
| --- | --- |
| `jobId` \| `uploadId` | exactly one: a succeeded job of the project, or a ready upload of the project |
| `env` | `preview` (default) or `production` |
| `pagesProject` | the target, one of `pagesProjects`, or — with `createIfMissing` — a new name (1–58 `[a-z0-9-]`, no leading / trailing hyphen) |
| `createIfMissing` | default false; without it a name that is not the target / listed is refused (403 `pages_project_not_allowed`) |
| `productionBranch` | only for a new project (default `main`) |
| `domain` | optional host name |
| `dns` | `auto` (default) or `skip` |
| `directory`, `bundleSha256` | job deploys only (as `pages.deploy`) |

A name that **exists** in the Cloudflare account but is not one of the project's Pages projects is refused (409
`pages_project_exists`): adopting someone's existing project stays a deploy-target change (project admin + step-up,
ADR-0037 §4) and is never part of a bundle.

### 1.2 Plan and diff

`diff = {action: 'publish', project, env, branch, productionBranch, source, jobId|uploadId|upload, fileCount, bytes,
steps: [...], links}`; each step carries its own decision:

- `{step: 'create', project, productionBranch, subdomain, decision}` — the predicted `<name>.pages.dev` (Cloudflare
  may add a suffix; the domain step uses the real one at execution).
- `{step: 'deploy', project, env, branch, fileCount, bytes, files[], decision, key}` — `key` is exactly the plan key
  `pages.deploy` will compute (`sha(project, env, filesHash)`).
- `{step: 'domain', domain, subdomain, attach: attach | already attached, dns: {action: create | update | unchanged |
  skipped | manual, zone?, before?, after?, record?}, decision}` — a domain already attached with a correct CNAME is
  a step `done` at plan time (nothing to do).

Refusals at plan time (nothing stored): the console host / protected names (as `pages.add_domain`), a zone of the
account that is not allowed for the project (403 `zone_not_allowed`), A/AAAA records on the domain (409
`dns_conflict`), more than 20 further Pages projects, the upload / job checks of `pages.deploy`, the secret-flag of a
job bundle. The **plan key** covers every step's facts (project exists / listed, files hash, domain attached, zone,
the DNS record before) — an approval re-plans and a changed fact makes the bundle `failed` with "the target changed
since the request" (ADR-0028 `stale`).

### 1.3 Execution

The bundle's own state is `executing` → `deploying` (chain running) → `succeeded` | `failed`; `result.steps[i] =
{step, state: pending | running | waiting | done | failed | skipped, actionId?, error?, note?}`.

For step *i* the master:

1. **Re-checks the people**: the approver (the bundle's `decided_by`, or the pre-approving creator) is active and
   still holds `deploy.approve` in the project when the covered level is above auto; a user requester still holds
   `deploy.request`. Otherwise: bundle failed ("… may no longer …; nothing more was executed").
2. **Requests the child** (`pages.create_project {name, productionBranch}` / `pages.deploy {jobId|uploadId, env,
   pagesProject, bundleSha256?}` / `pages.add_domain {domain, dns, pagesProject}`) as the bundle's requester,
   `via` = the bundle's, idempotency key `pb:<bundle>:<step>`, no rate limit (the bundle counted),
   `preApproved = {by: approver, at, stepUpAt, covers: the bundle's decision}`, `expectEnv` for the deploy, and a
   **precondition** compared with the child's fresh plan before anything is stored:
   - deploy: the child's plan key equals the planned `key` (same project, environment and file hashes);
   - domain: same project, domain and zone; the DNS record before is the one planned (or already ours);
   - create: the name is still not in the account and not listed.
   A changed precondition → 409 `stale`, bundle failed: "Step <x>: the target changed since the approval; nothing
   was executed for this step." The child's own plan re-checks the rest (zones still allowed, protected names,
   control plane, secret-flag of the bundle, upload still there).
3. **Follows the child**: `succeeded` → next step; `deploying` → wait (the `ops-deploying` poller refreshes it;
   a domain child counts as done once Cloudflare accepted the domain and the CNAME is written — its validation is
   followed by the child itself); `awaiting_approval` (the project's policy became stricter than the bundle's
   approval) → the bundle waits for that approval; `failed` / `refused` / `denied` / `expired` → bundle failed with
   "Step <x> <state>: <reason>", chain stops, `deploy.failed` notification (and the deploy-on-success message).

Every step is audited by the child's own `ops.action.request / approve (preApproved) / execute` events; the bundle
adds `ops.publish.step` per step (state, child id).

## 2. Who approves, and when

### 2.1 Requested bundles — one approval

`POST /deploy/actions {kind: 'pages.publish', …}` (`deploy.request`), the **Upload a site** card, a confirmed chat
`draft_deploy {action: 'pages.publish'}` card and an **agent's** request (§4) create the bundle; the policy decides
(§3): auto → runs at once; otherwise it waits for **one** approval by `deploy.approve`, with an always-fresh code when
the decision is `approval_step_up`.

### 2.2 Pre-approved bundles — deploy on success

`deployOnSuccess` (composer, chat `draft_job`, automations) gains `{pagesProject?, createIfMissing?, domain?,
dns?: auto | skip}` (target `pages` only). At creation the master computes the bundle's level from the request and
the project's policy (no provider call: DNS is assumed to be written when `domain` is set and `dns` is `auto`) and the
creator must satisfy it **now** (ADR-0030): `deploy.request`; `deploy.approve` above auto; an always-fresh code when
the level is `approval_step_up` (always when production or DNS is involved, unless every step runs at once). The
row stores `publish = {pagesProject, createIfMissing, domain, dns}` and a snapshot `{pagesProject, domain, zone}`
(the allowed zone that contains the domain, by name); on success the tick re-checks the snapshot (same Pages project
name; the zone still allowed) and requests `pages.publish` with the pre-approval. Requests without the new fields
keep the old `pages.deploy` path unchanged.

## 3. Policy

| Step | Level |
| --- | --- |
| create | `policy.pagesProject` |
| deploy | preview: `policy.previewDeploy`; production: `policy.productionDeploy` (never auto) |
| domain | `policy.pagesProject`; with the CNAME write the stricter of it and `policy.dnsChange` |
| bundle | the strictest step; **approval with step-up** when it is not auto and production or a DNS write is involved; refused if any step is refused |

**DNS "Run at once"** (`policy.dnsChange = 'auto'`, Project → Deploy): limited to **creates and updates of CNAME
records whose content is the `pages.dev` name of one of the project's own Pages projects** (target or further
projects, as Cloudflare reports them) inside the project's allowed zones (`dns.upsert` and the CNAME of
`pages.add_domain`). Everything else keeps its level: any other record type or content → **approval**; deletes →
approval + step-up (always); restoring a deleted record → approval; protected names, mail records, the console host
and control-plane contents → refused. A project that wants agents (or the upload card) to publish preview sites onto
its domains without any human sets `previewDeploy`, `pagesProject` and `dnsChange` to auto. **Production deploys keep
at least "Approval"** — run at once only through a pre-approved bundle / deploy on success.

## 4. Agents

- **Chat assistant:** `draft_job.deployOnSuccess` takes the four fields ("şunu x.example.org'de yayınla" for a job it
  drafts) and the card lists the whole chain (create → deploy → domain → CNAME) with one confirmation + code;
  `draft_deploy` gains `action: 'pages.publish'` (a finished job, optional upload id) for one card → one approval.
  Prompt rule 15 says so. (Worker release.)
- **Agents inside a job:** a new in-job tool **`publish_site`** `{env?, pagesProject?, createIfMissing?, domain?,
  dns?, directory?}` next to `open_preview` (same in-process MCP server, same `PREVIEW_REQUEST` channel fenced by the
  live lease: `op.kind = 'publish'`). The master records it as the job's publish request (`job_deploy_on_success`
  row with `covers = 'none'`, `via = 'job'`, requester = the job's creator, re-authorized now and at run time): when
  the job **succeeds** the master requests the whole chain as ONE `pages.publish` — one approval card, or none when
  the project's policy says run at once for every step involved (never for production). Offered only to trusted-source
  jobs created by a person in projects with a Pages target or further Pages projects, on workers with the feature
  `site-publish-v1` (Claude Code; ASSIGN_JOB `execution.previews.publish`). A job that already deploys on success
  keeps its creator's pre-approved request (the tool says so). Audited `ops.publish.agent_request` (success / denied
  with the reason); refusals: not a person's job, untrusted source, already requested, creator no longer allowed, no
  deploy targets, a Pages project that is not the project's (without `createIfMissing`). An agent's request may publish
  the job's output files when it built no site bundle (the approval shows the files); a pre-approved one stays bound
  to the job's own bundle. (Worker release.)

## 5. Small fixes found live

- **Provider errors:** `OpsError` for a provider failure is now **424 Failed Dependency** (was 502, which Cloudflare's
  proxy replaces with its own page, so the console showed "Unexpected response from the server"), message prefixed
  with the provider ("Cloudflare: list DNS records: Authentication error"); a 401 / 403 on a zone's DNS records adds
  "— the token needs Zone → DNS → Edit for <zone>". Deploy on success retries 424 only for unavailable / network
  provider failures (and 429).
- **Test connection (Cloudflare):** probes `GET /zones/{id}/dns_records?per_page=1` for every zone some project
  allows and reports per zone ok / "missing Zone → DNS → Edit", plus the hint that the account-level permissions
  "DNS View", "Account DNS Settings" and "DNS Firewall" do **not** cover a zone's records.
- **Upload a site card:** lists the project's recent uploads (`GET /projects/:id/site-uploads`), so an earlier upload
  can be deployed after a page reload; it also publishes with the bundle (choose / create the Pages project, optional
  domain) — one Request → one approval.
- **Ops action page:** the header shows the real state text (Succeeded / Failed / Denied / …) after a decision instead
  of "Waits for approval".

## 6. Security review

| Threat | Control | Test |
| --- | --- | --- |
| One approval silently covering more than shown | The bundle's diff lists every step with its own decision; the plan key covers all steps' facts; children re-plan and must match the planned facts (precondition) — otherwise the step is refused | precondition change → `stale`, chain stops |
| Approval reused for other actions | Children are requested only by the bundle executor with `source.publishBundle`, key `pb:<id>:<step>`, the bundle's decision as `covers`; preApproval never covers a refusal; a stricter policy → the child waits for an approval | stricter policy → child awaiting approval |
| Privilege drift between approval and a later step | Approver (`deploy.approve`) and user requester (`deploy.request`) re-checked before every step | demoted approver → bundle failed |
| Taking over a Pages project of the account | `createIfMissing` only for names new in the account; existing unlisted names refused (adopting stays admin + step-up) | exists → 409 |
| DNS run-at-once abused to repoint names | Only creates/updates of CNAMEs to the project's own `pages.dev` names inside allowed zones; protected names, mail, console host, control plane refused; deletes approval + step-up | policy unit matrix; integration: A record / foreign CNAME with auto → approval |
| Production without the owner | `productionDeploy` has no auto; a bundle with production needs approval + always-fresh code, or a pre-approval made with one (and the project switch for deploy on success) | production bundle → approval_step_up; stale code 403 |
| Prompt-injected agent publishing | `publish_site` only from trusted-source jobs created by a person (re-authorized), only after the job succeeded, through the policy (default: one human approval); production never at once; output only fills the secret-scanned bundle / output files | agent request → awaiting approval; untrusted → refused |
| Error text leaking secrets | Provider messages are the provider's (truncated, 300 chars) plus fixed hints; the token is never part of a message | canary token absent |

Residual: a human approving a malicious-but-plausible bundle; a project that turns every step to "Run at once" lets a
trusted job's agent publish previews onto its allowed zones unattended (owner's explicit choice).

## 7. Tests

- Unit `apps/master/test/unit/ops-policy.test.ts`: DNS auto matrix, publish level.
- Integration `apps/master/test/integration/publish-bundle.test.ts` (fake Cloudflare): upload → bundle (create +
  production deploy + domain + CNAME) → one approval with a fresh code → chain runs, children pre-approved and
  linked; stale code refused; failure in the middle (deploy fails) stops the chain, no domain; precondition change
  (record created meanwhile) refused; run-at-once (all auto, preview) runs without approval, a foreign CNAME / A
  record with DNS auto still needs approval; deploy on success with publish fields (pre-approved with TOTP, runs on
  success); provider 424 with the hint; Test connection DNS probe per zone.
- Web: composer publish fields, chat card chain, upload card (recent uploads, publish options), ops page header,
  integrations DNS lines.
- Chat: `draft_job.deployOnSuccess` publish fields (protocol + master preview).
- Worker / adapters: `publish_site` tool, assignment flag, host → PREVIEW_REQUEST op `publish`.

## 8. Rollback

- Of a bundle: each child keeps its own rollback (Pages production → previous deployment; DNS → previous record);
  a created Pages project / attached domain is removed in Cloudflare by the owner (as `pages.create_project`).
- Of the feature: migration 0084 is additive (constraint widening, one nullable column). An older master does not
  know `pages.publish` rows (list shows them as unknown kind → the strict response schema would fail): finish or
  deny open bundles first. A stored `dnsChange: 'auto'` makes an older master's strict policy parse fail for that
  project (no deploy targets) — set it back to Approval before rolling back.
