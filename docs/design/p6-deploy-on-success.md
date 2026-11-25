# p6-deploy-on-success — deploy a job's result automatically when it succeeds

- **Task:** `p6-deploy-on-success`. **Date:** 2026-10-16.
- **Decision:** [ADR-0030](../adr/0030-pre-approved-deploy-on-success.md) (amends ADR-0028 §3 / §6 / §8 for this one
  path; everything else of ADR-0028 stays).
- **Owner decision (2026-10-16):** "ben bir iş başlatıp, html vs. ürettirip deploy ettirip direkt linke erişmek
  istediğimde bunu yapabilmeliyim. iş bitince başarılıysa otomatik deploy etsin bana bilgi versin. bunu
  engellemeyelim." — when I start a job that produces HTML etc., it must deploy automatically when it finishes
  successfully and tell me the link. This overrides "every deploy starts from a card the owner approves" for this case.
- **Migration:** 0058 (`job_deploy_on_success`, `automations.deploy_on_success`, notification kind
  `deploy.succeeded`). **Worker release:** only for the chat path (the `draft_job` tool field and the system prompt
  live in `@remyral/protocol` / `@remyral/agent-adapters`, served by the worker's assistant host). Jobs, the composer,
  automations and the deploy itself are master-only; `deployOnSuccess` is never sent to a worker.

## 1. Shape

```
 creator (composer / chat card / automation save)
   │ POST /jobs {spec, deployOnSuccess:{target, env, directory?}}
   ▼
 master: prepare() ── validate · targets configured · production gate · permission + step-up for the policy level
   │ job + pre-approval row inserted in ONE transaction (job_deploy_on_success, audit ops.preapproval.create)
   ▼
 job runs on a worker (Pages: spec.siteBundle → secret-scanned site-bundle.json, re-scanned by the master)
   ▼
 orchestrator tick step "deploy-on-success"
   job FAILED/CANCELLED → skipped ("nothing was deployed")
   job SUCCEEDED → re-check (creator active + permission, production gate, target unchanged, bundle present and
                   unflagged) → OpsService.request(user = creator, preApproved) → executes at once (no card)
   ops action terminal → succeeded (URL) | failed (reason)
   ▼
 notify: chat message in the originating thread (with the URL) · job page "Deploy" step + status ·
         console notification deploy.succeeded / deploy.failed (in-app + the user's email / webhook channels)
```

| Piece | Where |
| --- | --- |
| Request shape, pre-approval levels | `apps/master/src/ops/model.ts` (`DeployOnSuccessRequest`, `DeployPolicy.autoDeployProductionOnSuccess`, `PagesDeployParams.bundleSha256`) |
| Prepare / record / tick / view | `apps/master/src/ops/on-success.ts` (`DeployOnSuccessService`) |
| Pre-approved execution | `OpsService.request(..., {preApproved})` in `apps/master/src/ops/service.ts` |
| REST | `POST /jobs` (`deployOnSuccess`), `GET /jobs/:id/deploy-on-success` (`jobs.read`) |
| Chat | `draft_job.deployOnSuccess` (`packages/protocol/src/assistant.ts`), `#draftJob` / draft confirm, prompt rule 15 |
| Automations | job target `deployOnSuccess` (column `automations.deploy_on_success`) |
| Notifications | outbox topic `ops.deploy_on_success`, kinds `deploy.succeeded` (new) / `deploy.failed` |
| Console | composer "Deploy when done", Project → Deploy "Allow auto-deploy to production on success", job page Deploy card + timeline step, automation form, chat draft card line |

## 2. The request

```json
{ "target": "pages" | "coolify", "env": "preview" | "production", "directory": "site" }
```

- `pages`: Cloudflare Pages project of the job's project (Project → Deploy). Implies `spec.siteBundle`: the master
  sets `{directory}` (default `site`) when the spec has none; a given `spec.siteBundle.directory` wins and
  `directory` must then be absent or equal. Repository and workspace jobs (workspace: `out/<directory>`).
- `coolify`: the configured Coolify application(s) of that environment (`coolify.deploy`, deploys what Coolify builds
  from git — e.g. the branch the job pushed). No bundle.
- The target **name** never comes from the request: only "pages" or "coolify" plus the environment; the master
  resolves the project, uuids/tags and the Pages project from the stored deploy targets (ADR-0028 §2).

## 3. Authorization — once, at creation

The creator's submission is the approval. `prepare()` computes the level the deploy policy asks for **now**:

| env | level (project policy) | creator needs at creation |
| --- | --- | --- |
| preview | `previewDeploy` = auto (default) | `deploy.request` (operator) |
| preview | `previewDeploy` = approval | `deploy.approve` (project admin) |
| preview | `previewDeploy` = approval_step_up | `deploy.approve` + always-fresh step-up |
| production | refused unless `policy.autoDeployProductionOnSuccess` (admin, default **off**) | then `deploy.approve` + the step-up `productionDeploy` names (default always-fresh) |

`jobs.create` is checked by the route as before. A refused request creates **no job** (the creator is told why
before anything runs). The pre-approval row records: job id, project, kind, environment, target snapshot, the level
covered (`auto` / `approval` / `approval_step_up`), approver = creator, approval time, step-up time, channel
(`api` / `chat` / `automation`), source (chat thread + draft, automation + run), expiry (creation + 8 days). Audit
`ops.preapproval.create` (success / denied with reason).

## 4. On success (tick step `deploy-on-success`)

Claimed rows (`pending` whose job is terminal; `FOR UPDATE SKIP LOCKED`, at most 10 per pass; `running` claims older
than 5 minutes are released):

1. Job `FAILED` / `CANCELLED` → `skipped` ("The job ended failed; nothing was deployed."). Expired → `skipped`.
2. Re-checks — any "no" → `refused` with the reason, nothing executed: creator still active and still allowed
   (`deploy.request`, and `deploy.approve` for a covered level above auto); production: the project setting is still
   on; the stored target equals the snapshot (Pages project name / Coolify uuids + tags of the environment).
3. Pages: the site bundle of the job's final attempt (`job_artifacts.kind = 'site'`; attempt = `current_attempt_id`
   when set). None → `failed` ("The job produced no site bundle …"); flagged by the master's scan → `refused`
   ("looks like it contains a secret"). Its SHA-256 is recorded and passed as `bundleSha256`; the Pages planner
   refuses any other bundle (binding to the exact bundle). Production uses the Pages project's production branch;
   preview the label `remyral-preview`. The plan's environment must equal the approved one.
4. `OpsService.request(actor = user creator, idempotencyKey = dos-<row id>, via = the creation channel,
   source = {deployOnSuccess, jobId, …}, preApproved = {by, at, stepUpAt, covers})`. The service decides by policy as
   always; when the decision is at or below `covers` the action is stored as decided by the creator ("Pre-approved
   at job creation (deploy on success)", `step_up_at` = creation step-up), audited `ops.action.approve`
   (`preApproved: true`) and executed at once. A stricter policy than at creation → the action waits for an
   approval like any other (`deploy.waiting` card) and the chat says so. Refusals (protected / control-plane) stay
   refusals. Retryable errors (429, provider 5xx) leave the row `pending` with a back-off (60 s, 5 tries).
5. `requested` rows follow their ops action (the existing `ops-deploying` poller moves Pages / Coolify
   deployments on): `succeeded` → URL (Pages deployment URL; Coolify: the first fqdn of the deployed resources);
   `failed` / `refused` / `denied` / `expired` → `failed` / `refused` with the action's error.

## 5. Telling the creator

On every final state (`succeeded`, `failed`, `refused`, `skipped`) once (`notified_at`):

- **Chat:** when the job came from a chat card, an assistant message in that thread: "Deployed job `<id>` to
  Cloudflare Pages (preview): <url>" or why not. Built from identifiers, enums, the provider URL and the master's own
  reason strings — never job output.
- **Job page:** a Deploy card (target, environment, state, link, reason, the ops action) and a final timeline step.
- **Notifications:** outbox `ops.deploy_on_success` → `deploy.succeeded` (info) / `deploy.failed` (warning) to the
  creator (link `/jobs/<id>`), through the existing channels (in-app, and email / webhook where the user turned them
  on). Skipped-because-the-job-failed is not notified again (`job.failed` already is).

## 6. Security review

| Threat | Control | Test |
| --- | --- | --- |
| Prompt-injected job content changes the target, environment or branch | Only `{target, env, directory}` from the creator; target resolved from the stored config; snapshot compared before running; job output can only fill the bundle, which is secret-scanned and published to the fixed project | on-success: target change → refused; bundle path/branch not taken from output |
| Job output publishing a secret | Worker drops the whole bundle on a hit; master re-scans and flags; flagged → refused; no bundle → failed | flagged bundle → refused, no Cloudflare call |
| Production without the owner | `autoDeployProductionOnSuccess` (admin-only targets write, step-up, default off) + `deploy.approve` + the step-up of `productionDeploy` at creation; setting re-checked before running | off → 409; no step-up → 403; turned off after creation → refused |
| Replay / reuse of a pre-approval | One row per job (unique), claimed with `UPDATE … WHERE state`, ops idempotency key `dos-<id>` per creator, 8-day expiry, the spec field is never copied by reruns (no row → no deploy) | double tick → one action; second request same key → same action |
| Swapping the bundle after approval | `bundleSha256` bound into the ops params (and the plan key); a different newest bundle is refused | unit + integration |
| Privilege drift after creation | Creator re-authorized at run time (disabled user / lost role → refused) | role removed → refused |
| A stricter policy after creation | Decided again at run time; above the covered level → normal approval card | policy raised → awaiting_approval |
| Automation runs deploying unattended | Saving needs the same permission + step-up as a job; each run re-checks run-as; untrusted sources (fork PRs, outside authors) never deploy | automation run from an untrusted source → no pre-approval |
| Chat assistant deploying on its own | `draft_job` only drafts; the human confirms the card (step-up); production needs always-fresh step-up at confirmation | chat test |
| Information in notifications / chat | Identifiers, enums, provider URL, master reasons only | — |

Residual risks: a preview deploy of whatever a trusted job built runs unattended by design (as ADR-0028's preview
auto); a production pre-approval is valid up to 8 days after the step-up (owner decision; the setting can be turned
off at any time and is re-checked); the Pages URL is what Cloudflare returns.

## 7. Tests

- Unit `apps/master/test/unit/deploy-on-success.test.ts`: level/permission matrix, production gate, step-up, spec
  rewrite (siteBundle), snapshot comparison.
- Integration `apps/master/test/integration/deploy-on-success.test.ts` (fake Cloudflare / Coolify): composer path
  preview → Pages deploy at once after SUCCEEDED, URL in the view, notification, audit; production gate off / on +
  step-up; failed job → skipped; flagged bundle → refused; target changed → refused; replay (two ticks, one action);
  chat draft → confirm → message in the thread; automation job target with deploy on success; GET route visibility.
- rbac / route-coverage: the new GET route (jobs.read, project-scoped).
- Web: composer toggle sends `deployOnSuccess`, job page Deploy card, Project → Deploy production switch.

## 8. Rollback

Turn the feature off per project by clearing the targets or (production) the switch; pending pre-approvals then
refuse. Migration 0058 is additive (new table, nullable column, one more notification kind).
