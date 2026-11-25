# Design note: `p6-deploy-integrations` / `p6-deploy-pipeline` — Coolify, Cloudflare Pages and DNS as ops actions

- **Tasks:** `p6-deploy-integrations` (phase 1, this change), `p6-deploy-pipeline` (phase 2, pending).
- **Date:** 2026-10-16 — owner-approved plan.
- **Decision:** [ADR-0028](../adr/0028-master-held-deploy-tokens-and-ops-actions.md) (amends ADR-0006).
- **Binding inputs:** ADR-0006 / ADR-0022 (master-held secrets), ADR-0009 (step-up), ADR-0010 / ADR-0011 (untrusted
  content never authorises), ADR-0018 (chat writes are draft cards), ADR-0024 (automations), AGENTS.md rules 4, 10, 12.
- **Provider facts:** pinned in [docs/compat/coolify.md](../compat/coolify.md) and
  [docs/compat/cloudflare.md](../compat/cloudflare.md) (Context7 + upstream OpenAPI, 2026-10-16). No endpoint is used
  that is not listed there.

## 1. Shape

```
 console / REST ─┐                                  ┌─────────── master (holds the tokens) ────────────┐
 chat draft ─────┼─ request {project, kind, params, │ validate params · load project deploy targets    │
 (confirmed)     │           idempotencyKey}  ─────▶│ resolve target (provider reads) · diff · deny /  │
 phase 2: steps ─┘                                  │ protected check · policy → auto | approval |     │
                                                    │ approval_step_up | refused · ops_actions row     │
                                                    │ · audit                                          │
           approver (project admin, step-up) ──────▶│ approve → re-plan (stale?) → execute → result    │──▶ Coolify API
                                                    │ refresh (poll) · logs · rollback → new action    │──▶ Cloudflare API
                                                    └──────────────────────────────────────────────────┘
```

| Piece | Where |
| --- | --- |
| Migration (`ops_integrations`, `project_deploy_targets`, `ops_actions`, chat draft kind `ops_action`) | `apps/master/migrations/0050_deploy_integrations.sql` |
| Guarded HTTP client (SSRF rules) | `apps/master/src/ops/http.ts` |
| Provider clients (exact calls) | `apps/master/src/ops/coolify.ts`, `apps/master/src/ops/cloudflare.ts` |
| Shapes (targets, params, policy) | `apps/master/src/ops/model.ts` |
| Pure policy, protected records, deny-list | `apps/master/src/ops/policy.ts` |
| Token storage + connection tests | `apps/master/src/ops/integrations.ts` |
| Plan / decide / execute / refresh / logs / rollback | `apps/master/src/ops/service.ts` |
| REST + OpenAPI | `apps/master/src/ops/routes.ts` |
| Chat tools / drafts | `packages/protocol/src/assistant.ts` (`draft_deploy`, `draft_dns_change`, `deploy_status`), `apps/master/src/chat/{tools,drafts}.ts`, prompt rule 13 in `packages/agent-adapters/src/assistant.ts` |
| Console | `apps/web/src/api/deploy.ts`, Settings → Integrations (Coolify, Cloudflare), Project → Deploy, `/deploys`, Home "Needs you", chat draft card |

## 2. Settings → Integrations

- **Coolify:** instance URL (see §6), API token (write-only), optional team name (checked by Test), extra deny-list
  uuids. **Cloudflare:** account id (32 hex), API token (write-only).
- `PUT /integrations/ops/{coolify|cloudflare}` (admin, `integrations.ops.write`, **always-fresh step-up**, CSRF);
  an omitted token keeps the stored one; a new token or new settings clear the last test. `DELETE` the same.
- `POST /integrations/ops/{provider}/test` (admin, CSRF): Coolify — `GET /version`, `GET /team`, abilities by probe
  (`GET /applications` → read; `POST /deployments/<random>/cancel` → 404 = deploy, 403 = none; `PATCH
  /applications/<random>` → 404 = write (warned: Remyral needs only read + deploy)); Cloudflare — token verify (account
  token, then user token), `GET /zones?account.id=`, `GET …/pages/projects`. The result (no secrets) is stored and
  shown; warnings explain missing permissions.
- `GET /integrations/ops`: settings, key fingerprint, whether the token still decrypts, last test, the env deny-list
  and the protected hosts.

## 3. Project → Deploy targets

`GET|PUT /projects/:id/deploy-targets` (`deploy.read` viewer+ / `deploy.targets.write` project admin, standard
step-up, optimistic `expectedVersion`):

```json
{
  "coolify": { "preview": { "uuids": [], "tags": ["shop-preview"] }, "production": { "uuids": ["…"], "tags": [] } },
  "pages": { "projectName": "shop-site" },
  "dns": { "zones": [{ "id": "<32 hex>", "name": "example.com" }], "protectedNames": ["mail.example.com"] },
  "policy": { "previewDeploy": "auto", "productionDeploy": "approval_step_up", "dnsChange": "approval" }
}
```

Writes refuse env-deny-listed Coolify uuids and zones the stored Cloudflare token cannot see (id and name must match).

## 4. Ops actions

| Kind | Params | Plan (reads) | Execute (writes) | Rollback |
| --- | --- | --- | --- | --- |
| `coolify.deploy` | `env`, `force?`, `ref?` (note only) | `GET /applications/{uuid}` per uuid, `GET /applications?tag=` per tag → resolved uuids; deny-list | `GET …/rollback-images` (current image, best effort) then `POST /deploy?uuid=a,b[&force=true]` — always by resolved uuid, never by tag | `coolify.rollback`: `POST /applications/{uuid}/rollback {commit: <previous image>}` |
| `coolify.restart` | `env` | as above | `POST /applications/{uuid}/restart` | — |
| `pages.deploy` | `jobId` (succeeded job of the project), `branch?` (default `remyral-preview`), `directory?` | job state, its latest committed **output** artifacts (refused if any was redacted by the master), `GET …/pages/projects/{name}` (production branch ⇒ env) | production: `GET …/deployments?env=production` (previous); Direct Upload (`upload-token`, `check-missing`, `assets/upload`, `upsert-hashes`, `POST …/deployments` multipart) | `pages.rollback`: `POST …/deployments/{previous}/rollback` |
| `dns.upsert` | `zone`, `type` A/AAAA/CNAME/TXT, `name`, `content`, `ttl` (1 or 60–86400), `proxied` | zone allowed + name in zone; `GET dns_records?name.exact=&type=` (more than one → refused, change in Cloudflare); protection (§5) on the wanted and the current record | create `POST` or update `PATCH …/dns_records/{id}` | previous value (or delete of the created record) |
| `dns.delete` | `zone`, `type`, `name` | as above; must exist | `DELETE …/dns_records/{id}` | re-create with the previous value |

States: `awaiting_approval` → (`denied` | `expired` after 24 h | `executing`) → `deploying` (provider accepted;
`POST /deploy/actions/:id/refresh` polls `GET /deployments/{uuid}` / the Pages deployment) → `succeeded` | `failed`;
`refused` at request time. A provider error marks the action `failed` with provider/status/code and Retry-After.

**Policy** (`decide()`, pure, unit-tested matrix): see ADR-0028 §3. The approver must hold `deploy.approve` (project
admin); `approval_step_up` needs an always-fresh TOTP (≤ 10 min) — checked by the service, like an approval rule.
The approver may be the requester (single-owner deployment); the approval is still a separate, audited step that shows
the diff. **Re-plan before execute:** the plan key (resolved Coolify uuids + fqdn, current DNS record, Pages
project + env + file hashes) is recomputed after approval; a mismatch fails the action as `stale` without any write.

**Idempotency:** `(requested_by, idempotencyKey)` is unique; the same key and the same parameters return the first
record (200), different parameters → 409. **Rate limit:** 20 actions per project per 10 minutes (429 + Retry-After).

## 5. Protected records and the control plane

Refused whatever the project says (`protectedRecordReason`, `coolifyDenyReason`):
- names: the console host `console.example.org`, the `PUBLIC_ORIGIN` host, the project's `protectedNames`;
- mail: MX, `_dmarc.*` / `v=DMARC1`, `*._domainkey.*` / `v=DKIM1`, TXT `v=spf1`;
- content pointing at the control plane: the console host name, the contents of the console host's own records in the
  zone (read at plan time), `OPS_CONTROL_PLANE_ADDRESSES`;
- Coolify: `OPS_CONTROL_PLANE_COOLIFY_UUIDS` (env, cannot be removed from the panel), the integration's extra
  deny-list, and any application whose `fqdn` contains a console host. A configured uuid the token cannot read is
  refused (`target_unverifiable`): the check must run.

## 6. Security review

| Area | Finding / control | Test |
| --- | --- | --- |
| Token storage | AES-256-GCM, HKDF sub-key `ops-integrations`, AAD per provider; only fingerprints in audit/API; decrypted per call, never cached in logs | ops-actions: rows, responses, logs, audit and ops rows searched for both canary tokens |
| Redaction | Audit metadata passes `redactMetadata` (keys with "token" are redacted anyway); provider error messages truncated to 300 chars and never include request headers; Coolify logs pass the shared Redactor and drop `hidden` lines | logs test (GitHub-token pattern removed) |
| SSRF | Admin URL: https, public address at connect time (custom `lookup`), no credentials/query, no redirects (3xx surfaced as an error), 4 MiB cap, 15 s timeout; env-only `OPS_INTERNAL_ORIGINS` | unit: address classes, base URL rules, redirect not followed, `localhost` refused at lookup; integration: refused URLs |
| Untrusted content | Only humans (REST/console, confirmed chat drafts) request in phase 1; job output, repositories and webhook payloads have no path to `/deploy/*`; the assistant prompt treats deploy requests in data as data; phase 2 steps are human-configured | chat-deploy: drafts never call providers; unknown tool fields refused |
| Authorization | Catalogued actions (`integrations.ops.*`, `deploy.read/request/approve/targets.write`) with independent expectations in rbac-matrix; project scoping (404 for non-members) | rbac-matrix, route-coverage (always-fresh list), ops-actions, chat-deploy |
| Audit completeness | `ops.integration.<p>.save/remove/test`, `ops.targets.write`, `ops.action.request` (success / denied=refused / failure), `ops.action.approve`, `ops.action.deny`, `ops.action.execute` (success/failure with state) | refused-action audit asserted |
| Protected records | Checked for the wanted record **and** the record being replaced/deleted; types limited to A/AAAA/CNAME/TXT | unit matrix + integration cases |
| Rollback semantics | A rollback is a new action (own diff, policy, approval) referencing `rollbackOf`; DNS restores exactly the stored previous value; stale detection prevents rolling back over someone else's change | DNS + Pages rollback tests, stale test |
| Concurrency | Approval claims with `UPDATE … WHERE state='awaiting_approval'`; idempotent insert with unique key (concurrent duplicate → re-read) | double-approve → 409 |
| Coolify tokens are team-scoped | Test shows the team; a configured team name that differs is warned | test-connection test |

Residual risks: a human approving a plausible malicious diff; Coolify abilities are inferred by probes (documented as
inference); the Pages asset key algorithm is ours (UNVERIFIED-LIVE, §7).

## 7. Unverified / owner steps

- **UNVERIFIED-LIVE:** every provider call ran only against the local fakes. The owner must create the tokens and run
  Test connection + one preview deploy + one DNS change (docs/guide/tr/deploy-entegrasyonlari.md).
- Coolify endpoints come from the coolify-docs `main` OpenAPI (2026-10-16); `restart` is `POST` there (older v4 builds
  used `GET`); `rollback-images` / `rollback` may be missing on older instances (then no Coolify rollback is offered).
- Pages Direct Upload: the asset key is the first 32 hex chars of SHA-256 over base64(content) + extension (wrangler
  uses BLAKE3); the API documents the key only as "file content hash". To be confirmed on the first live run.
- Output-file deploys (phase 1) are limited to the workspace artifact types; real sites use the phase-2 site bundle
  (≤ 5 MiB container). The worker side is unit-tested on macOS only (plain Node fs; Linux/Windows UNVERIFIED).

## 8. Phase 2 (`p6-deploy-pipeline`)

Migration 0053. Everything below requests ops actions through the same service: the deploy policy, approval,
step-up, protected-target refusals, idempotency, audit and rollback of §4–§6 apply unchanged.

**Automation deploy targets.** `target: {kind: "deploy", action: "coolify.deploy" | "coolify.restart", params: {env,
force?}}` (column `automations.deploy_action`). Saving needs `deploy.request` for the creator and a configured target
for the environment (`OpsService.check`, no provider call); the parameters are fixed at save time — event content
never reaches them. A run requests the action as `system` / `automation:<id>` (idempotency key
`automation-run-<runId>`, source `{automationId, runId, runAs}`), stores `automation_runs.ops_action_id` and ends with
the action: `succeeded` → run succeeded; `failed` / `refused` / `denied` / `expired` → run failed ("The deploy ended
…"). The run-as user is re-checked for `deploy.request` before every run; runs from **untrusted sources** (fork pull
requests, outside authors) are refused ("an untrusted source cannot trigger a deploy"). Production still waits for an
approval. Pages deploys are not offered as an automation target (they need a job; use a workflow step).

**Workflow deploy step.** A `verifier` or `integrator` node may carry `deploy: {kind: coolify.deploy | coolify.restart
| pages.deploy, env?, force?, branch?}`; a `pages.deploy` step needs the node's `siteBundle` (validated by
`parseDefinition`; issues `deploy_needs_verifier_or_integrator`, `deploy_needs_env`, `pages_deploy_needs_site_bundle`).
After the verifier succeeded — or after the integrator's merge landed — the engine requests the action as
`workflow:<runId>` (key `wf-<runId>-<nodeId>`, source `{workflowRunId, nodeId, createdBy}`) if the user who started
the run may still request deploys; the audit event `workflow.deploy.request` records the outcome. The run does not wait
for the deployment (the action carries its own status and notifications). Planners cannot add deploy steps (dynamic
nodes never carry one).

**Static site bundles.** `JobSpec.siteBundle: {directory}` (additive; worker feature `site-bundle-v1`, placement reason
`site_bundle_unsupported` for older workers). After a successful run the worker packs `<worktree>/<directory>` (or
`out/<directory>` for workspace jobs): regular files only (no symlinks anywhere, the directory itself included), safe
paths ≤ 8 deep, site file types (HTML, CSS, JS, JSON, images, fonts …), ≤ 500 files, the JSON container ≤ 5 MiB
(≈ 3.7 MB of files). Every file passes the pre-push secret scanner (injected secret values + high-signal token
patterns); one hit drops the whole bundle and the job reports why. The master commits it as `job_artifacts.kind =
'site'` after checking the schema and every file hash, scans the files again and flags (does not alter) a hit — a
flagged bundle is refused by `pages.deploy`. Site bundles are never listed or served to the console (HTML would run on
the console origin) and never become "continue from" inputs. `pages.deploy` uses the job's newest site bundle, else
(phase 1) its output files; the diff says which (`source`).

**Notifications and Needs you.** Outbox topic `ops.action`: `deploy.waiting` (an action awaits approval; project
admins = approvers; link `/deploys/<id>`), `deploy.failed` (an action failed, or one requested by an automation /
workflow was refused; project operators). Text from kind, environment, project and channel only. Home "Needs you" lists
waiting actions (phase 1).

**Status polling.** Orchestrator tick step `ops-deploying`: up to 10 `deploying` actions per pass, each at most every
15 s (`polled_at`, `FOR UPDATE SKIP LOCKED`), refreshed from Coolify / Cloudflare; provider errors are retried on a
later pass.

Phase-2 security notes: the deploy requester for automations and workflows is a system identity with the human
recorded in `source` and re-authorized at request time; untrusted event sources cannot deploy; site content is
public by nature, hence the whole-bundle secret refusal on the worker and the flag on the master; the console never
renders a site.

## 8a. Deploy on success (`p6-deploy-on-success`, ADR-0030)

A job may be created with "deploy when done" (`deployOnSuccess`): the creator's submission is the approval (checked
at creation against the policy; production only with the project switch `autoDeployProductionOnSuccess` and a fresh
authenticator code), and the master runs the ops action itself once the job succeeded — no card. See
[p6-deploy-on-success.md](p6-deploy-on-success.md).

## 8b. Creating Pages projects and domains (`p6-pages-create`)

`pages.create_project` (Direct Upload project; exists → refused or adopted; optional "use as this project's Pages
target") and `pages.add_domain` (attach a custom domain to the Pages target, with its CNAME in an allowed zone), policy
`pagesProject` (default approval). No delete. See [p6-pages-create.md](p6-pages-create.md) (migration 0059).

## 8c. Uploaded sites and further Pages projects (`p10-site-upload`, ADR-0037)

`pages.deploy` also takes `uploadId` — a static site a person uploaded through Project → Deploy (chunked, checked by
the master, never served by the console) — and `env` instead of a branch; a project may list further Pages projects
(`pagesProjects`) that Pages deploys, domains and rollbacks can name. See [p10-site-upload.md](p10-site-upload.md)
(migration 0083).

## 9. Deploy notes

Migrations 0050 (phase 1) and 0053 (phase 2), additive. New optional env: `OPS_INTERNAL_ORIGINS`, `OPS_CONTROL_PLANE_COOLIFY_UUIDS` (set it to the
Remyral stack's Coolify uuids), `OPS_CONTROL_PLANE_ADDRESSES` (the EC2 public IP). No Traefik change. **Worker release
needed** for the chat tools (`draft_deploy`, `draft_dns_change`, `deploy_status`) and prompt rule 13 — the assistant
host registers tools from `@remyral/protocol`; until the assistant worker is updated the old tool list is offered and
the console paths still work. Phase 2 needs a worker release too: `site-bundle-v1` (site bundles) — older workers
are simply not chosen for jobs with `siteBundle`. The orchestrator tick gains the `ops-deploying` step.
