# p18-multi-project — workflows, automations, chat, jobs and templates across several projects

Status: **W1 + W2 built** (shared workflows, per-project triggers and settings — §9); **W3 + W5 built** (the chat's
working projects, job fan-out batches — §10; worker 1.2.1 for the assistant part); **W4 built** (automation groups,
template library — §11). Owner direction 2026-10-28: "workflowlar vs. birden fazla projeyle çalışabilmeli."
Owner choices: workflows use the **shared workflow** model ("Paylaşılan workflow": one workflow attached to several
projects; each run belongs to one project and runs with that project's context; its steps never leave that project).
Also multi-project: **Otomasyonlar/zamanlamalar, Sohbet, İşler, Şablonlar**.
Not chosen (out of scope): "home project + per-step target project", "project-less org-level workflow".

Paths are relative to the repo root; `m/` = `apps/master/`, `mig/` = `apps/master/migrations/`, `wn/` =
`packages/workflow-nodes/src/`, `web/` = `apps/web/src/diyalog/`.

---

## 1. Today: everything is bound to one project

**Projects & RBAC.** `projects` + `project_memberships` (`mig/0010_rbac.sql`). owner/admin are global; operator/viewer
are per project (membership role capped by the account role). Actions are declared in `m/src/authz/model.ts` with
`scope: 'project' | 'global'`. Workflow actions (`:489-534`): `workflows.read|define|run|approve|test|activate`
(viewer/operator), `workflows.define.network|deploy|code` and `workflows.egress.write` (project **admin** + step-up).
Automations (`:544-567`) include `automations.external` (admin) and `automations.crossproject` (admin, needed in both
projects). Templates (`:569-584`): `templates.read|write` per project, `templates.global` (admin). `vault.*`,
`quotas.*`, `security.*`, `integrations.*`, `chat.use` are global.

**Workflows (v2 engine).**
- Definitions: `workflow_definitions (project NOT NULL, name, version)` append-only, `UNIQUE (project, name, version)`
  (`mig/0017_quotas_and_workflows.sql`). Identity of a workflow = `(project, name)`; route ids are version uuids
  (`m/src/workflows/routes.ts:200-500`). Body schema `wn/v2.ts:162` (`inputs`, `defaults`, `settings`, nodes, edges);
  `defaults.repository` is optional (`wn/v1.ts:133-145`).
- Runs: `workflow_runs.project` (FK) + `definition_id`; identity columns immutable via `workflow_runs_guard()`
  (rewritten in `mig/0103`, `0106`, `0112`). `startRun` takes the run's project **from the definition**
  (`m/src/workflows/engine.ts:904-990`: `d.project` for archive check, project kind, repository fallback).
- Archive: `workflow_archives (project, name)` (`mig/0098`). Definition save re-validates against the project's
  kind (workspace vs repository) and egress (`engine.ts:395-433`).
- Triggers: trigger nodes are reconciled into one automation each — `workflow_trigger_bindings (project, name,
  trigger_node_id) → automation_id, pinned_version, enabled` (`mig/0103:227`, `m/src/workflows/triggers.ts` header).
  Webhook URL = `/v1/hooks/<automation id>` (`m/src/automations/hooks.ts:33`). Run-as = the activating user;
  webhook/GitHub triggers need `automations.external` + step-up.
- Approvals: gate role per node (`workflow_nodes.gate_role` operator/admin/owner), decided by the project's members.
- Error workflow: `settings.onFailure.workflow` — "the error workflow of the **same project**" (`wn/v2.ts:150`;
  `m/src/workflows/v2/engine.ts:4884`). Sub-workflows of another project are refused (`v2/engine.ts:3226-3240`,
  `cross_project_not_allowed`).
- Retention: `settings.retentionDays`, else `projects.workflow_data_retention_days` (`mig/0103:288`); concurrency and
  failure-streak indexes are `(project, name, …)` (`mig/0112`).
- Secrets: HTTP / e-mail nodes reference a **global** vault credential id literally in the definition
  (`m/src/workflows/v2/functions.ts:82-115`, `boundCredential`: active, right kind, bound to the host). The vault is
  global (`vault_credentials`, `mig/0030`); nothing ties a credential to a project. Adding/changing such a node needs
  `workflows.define.network` + step-up (privileged delta, `wn/privilege.ts`).
- Integrations (deploy/Pages/DNS, GitHub App, notify, jobs) resolve **from the run's project** and re-check the run's
  creator in it (`m/src/workflows/integrations.ts:48-63`, `ctx.project`). HTTP egress per project
  (`workflow_egress`, `mig/0103:244`).
- Memory/outputs: AI steps are ordinary jobs of the run's project (project memory `memory_records.project`,
  `mig/0092`; outputs `output_items.project`, `mig/0060`).
- Workflow templates: built-in gallery in code (`wn/templates/*`), instantiated **into one project**
  (`m/src/workflows/template-routes.ts:172,190`). AI panel threads: `chat_threads.workflow_project/name` (`mig/0122`).

**Automations / schedules.** `automations.project NOT NULL` (`mig/0043`), one trigger, one target (job spec or
workflow version), `run_as`, webhook secret, catch-up, rate cap. Schedules are a thin alias
(`m/src/schedules/service.ts` header). Chains may cross projects with `automations.crossproject`.

**Chat.** Threads are private per user. `chat_threads.project` + one `project_share` boolean = "Proje bilgisiyle
paylaş" (`mig/0081`; `m/src/search/chat-knowledge.ts:440-575`; UI `web/chat/ContextStrip.tsx`). Messages already link to
**several** projects (`chat_message_links`, computed from thread project, mentions and drafts —
`chat-knowledge.ts:394`), related-context lookup uses thread project + @mentions (`:1095`). Tools take an optional
`project` per call (`packages/protocol/src/assistant.ts`, ~40 tools) and each call is authorized per target
(`m/src/chat/tools.ts:884 #can`). Drafts carry `chat_drafts.project` (`mig/0034:72`).

**Jobs.** `jobs.project`; one repository per job, which must equal the project's registered repo
(`project_git_configs.repository_url`, `mig/0016`), or a scratch workspace (`projects.kind`, `mig/0033`). Per-project
policy: approval rules (`project_policies`), execution flags on `projects` (host/unconfined/auto-approve/safe
commands/subtasks…), egress (`project_workspaces`, `project_repo_egress`), repo credentials
(`project_repo_credentials`), deploy targets, merge pipeline (`projects.integration_*`). Sub-jobs stay in the
parent's project (`job_subtasks`, `mig/0065`). Quotas: `usage_budgets` scope `project` (`mig/0009:126`),
`quota_project_holds` (`mig/0017`), `cost_brake_projects` (`mig/0142:79`), queue caps on `projects` (`mig/0071`).
Security policy is a global singleton (`mig/0118`).

**Templates.** `job_templates.project` NULL = global (admin), else project (`mig/0069`;
`m/src/templates/service.ts:36,160-212`); a global template cannot default to full access (`:415`).

**Audit.** `audit_events` has `action/target/metadata` (no project column, `mig/0001`); project goes in metadata.

Precedent for per-project secret binding: `mcp_secret_bindings (server_id, project | '*', slot → vault credential)`
(`mig/0102:162`). We reuse that shape.

---

## 2. Target model

### 2.1 Workflows — owner project + attachments

**Where the definition lives: in its owner project (decision).** `workflow_definitions` stays exactly as it is; the
project that owns the version line is the **owner project**. Other projects **attach** it.
Why not a separate library scope: (a) `workflow_definitions` is append-only with `project NOT NULL` — a library
scope means a new nullable/`'*'` identity, rewriting every `(project, name)` lookup and the archive/trigger/
concurrency keys; (b) editing rights would need a new global authority, taking authoring away from project operators
who define workflows today; (c) the privileged-delta + step-up rule (`wn/privilege.ts`) already has a natural home:
the owner project's admins. A team that wants a neutral "library" simply creates an ordinary project for it
(e.g. `ortak`) — no special case.

**Sharing is two-sided.** The owner project's admin *offers* a workflow (to all projects or listed ones); a target
project's admin *attaches* it. Without an offer the definition is not even visible to the target (it may reveal the
owner's internals); once attached, the target's viewers can read the versions they run (read-only).

**Attachment** = `(project, owner_project, name)` with:
- `state`: `enabled | disabled | detached` (detached keeps the row for run history).
- **Version line**: one line (the owner's). `follow = auto | pin`. `version` = the version this project runs.
  - `auto`: when the owner saves version N+1 the service advances the attachment **only if** the privileged delta
    (`privilegedDelta(version, N+1)`) is empty and the inputs remain compatible (no new required input without an
    override default). Otherwise it sets `pending_version` and notifies the target's admins ("güncelleme onay
    bekliyor"); they accept with the same right + step-up the owner needed (`workflows.define.network|deploy|code`
    **in the target**).
  - `pin`: never moves; the admin advances manually (same checks).
- **Overrides** (validated jsonb, all optional): input defaults; `repository` (default: the target's registered
  repository — the owner's `defaults.repository` is **never** used outside the owner project, it would be refused
  anyway by the "jobs name the project's repository" rule); approver role per gate node (may only **raise**, never
  lower the definition's role); `retentionDays`; `onFailure` (a workflow name resolved in the target); per trigger
  node: cron + time zone, GitHub repo/event filter; concurrency `max` (only ≤ the definition's).
- **Credential bindings**: every vault credential id written in the definition is treated as a **slot**. In the owner
  project it resolves to itself (today's behaviour). In a target it resolves only through
  `workflow_attachment_credentials (attachment, slot → credential)`, set by the target's admin (step-up). An unbound
  slot makes the attachment not enableable (`credential_unbound`) — so an owner editor can never make a run in B use
  A's credential unless B's admin bound it.
- **Integrations** need no binding: deploy targets, GitHub App repo, DNS zones, notification recipients, egress
  policy, approval policy, execution flags, memory and outputs all come from the run's project already
  (`integrations.ts`). Attaching re-validates the definition against the target (kind, egress, integrator vs
  workspace, missing deploy target) and returns a report.

**Runs.** A run belongs to the project it ran in: `workflow_runs.project = target`, `definition_id` = the owner's
version row, plus a new `attachment_id`. Concurrency, failure streaks, retention and archive checks key on
`(run project, local name)`. Run-as / integrations / quotas / approvals: the target's. Names are resolved in the run's
project: sub-workflow and error-workflow names must exist (own or attached) in the target — "steps stay inside the
one project". Cross-project sub-workflows stay refused.

**Names.** A project's workflow namespace = own names ∪ attached names; the service refuses an attach (or a new own
workflow) whose name collides (`name_taken`). No aliasing in v1 (open question avoided: duplicate instead).

**Owner project = implicit attachment.** Existing workflows need no row: a resolver returns a synthetic
self-attachment (`follow auto`, no overrides, owner credentials). Every existing workflow, trigger binding, run and
route behaves unchanged.

**Editing rights.** Only the owner project's `workflows.define` (+ privileged actions + step-up) edit the definition.
An owner editor need not administer the targets: their power over B is limited to non-privileged changes that B
follows automatically (AI step prompts, data shaping) — and B can pin. Everything with side effects (network, deploy,
code, credentials, triggers from outside) needs B's admin. Target operators who want to change it use
"Projeye kopyala" (duplicate into B → becomes B's own workflow; the existing duplicate route gains `targetProject`).

**Archive / delete in the owner.** Archiving warns with the list of attached projects and stops new runs everywhere
(attachments show `owner_archived`); running runs finish. Detach pauses the attachment's bound automations (history
kept), exactly like deactivation today.

**Webhooks.** Each attachment activates its own trigger bindings → its own automation → its own
`/v1/hooks/<automation id>` URL and secret (the existing `workflow_trigger_bindings` PK `(project, name, node)`
already separates projects). Run-as = the activating user of that project.

**Error workflow and retention**: per run project (override → definition setting → project default).

### 2.2 Automations / schedules — per-project instances, grouped (decision)

Automations stay **per-project rows**: run-as, webhook secret, GitHub routing, catch-up, `next_run_at`, run history
and the run-as re-check are inherently per project, and external triggers need each project's admin + step-up.
An attachment-style single row would have to fan these out anyway. Multi-project = an **automation group**:
"Projeler" multi-select in the form creates one automation per selected project (each authorized separately; the
ones refused are listed), linked by `group_id`. "Tümüne uygula" edits all siblings the editor may change (step-up as
today), others are flagged `diverged`. Workflow triggers of shared workflows already produce per-project automations
(§2.1); they are not grouped (the attachment is their group).

### 2.3 Chat — a thread with a project set

- `chat_threads.project` stays the **primary** project; `chat_thread_projects (thread, project, share)` adds more.
  The set = primary ∪ extras (max 8). Each member has its own "Proje bilgisiyle paylaş" switch (the primary keeps
  `project_share`). Indexing/sharing rules in `chat-knowledge.ts` apply per member (consent, access, personal pref).
- Adding a project requires `projects` read access; losing access drops it from the set at the next turn
  (message shown).
- Tools: read tools without `project` search the set (not all visible projects). **Write tools must name the project**
  when the set has more than one member; the server refuses `project_required` / `project_not_in_thread`. Every tool
  row and draft card shows a project chip; drafts already carry `chat_drafts.project`. Permission is checked per
  target as today (`tools.ts #can`).
- Prompt: a "Çalışma projeleri" block (id, name, kind, the user's role, sharing) and the rule "her eylem hangi
  projede olduğunu söyler; belirsizse sor" (ask-user tool).
- Coordinates with p17-chat-flow (workflow approval/question/result cards, workflow draft card): those cards get the
  project chip; the workflow draft card gains "projelere ekle" in W3.

### 2.4 Jobs — fan-out (recommended) vs multi-repo

| | A. Multi-repo job (one job, N repos) | B. Fan-out (one job per project) — **recommended** |
|---|---|---|
| Protocol / worker | `JobSpec.repositories[]`, multi-checkout workspace, git-flow per repo → **worker release** | none; N ordinary JobSpecs |
| Policies | whose approval policy, sandbox, egress, execution flags? needs a merge rule per field (escalation risk: most permissive wins by mistake) | each job under its own project's policy, unchanged |
| Credentials | worker needs every repo credential in one sandbox (cross-project secret exposure) | per project, unchanged |
| Placement | a worker eligible for all N projects (often none) | each job placed independently |
| Quotas | split cost across projects (no basis) | each job charged to its project; held/over-budget projects refused at submit |
| Outputs / merge / PR | one job, N branches, partial failures inconsistent | per project merge pipeline and PR; batch shows N results |
| Approvals / deploy | mixed | per project; deploy-on-success per project's targets |
| Fits owner model | contradicts "steps stay in one project" | consistent |

Fan-out: `job_batches` groups the jobs of one submission ("aynı işi şu projelerde yap"). One prompt + optional
per-project variables (`{{project.name}}`, repo) and per-project overrides; preflight per project (role, hold, budget,
repository, worker availability) → submit the allowed ones, list the refused ones. Approvals stay per job (grouped
in the UI by batch; no bulk approve in v1). The batch page shows state per project, outputs, PR links, cost total.
Coordinated cross-repo changes (API in A + client in B atomically) are out of scope.

### 2.5 Templates — library + visibility + instantiate into a project

- **Job templates**: the library = global templates (`project NULL`, admin) + project templates **shared** to other
  projects (`job_template_shares (template, project | '*')`, needs `templates.write` in the owner project and
  `templates.read` in each target). Per-project hiding: `job_template_hidden (template, project)` by the target's
  `templates.write`. Running always instantiates into one chosen project; the target's policy caps the run settings
  (the `full_access_global` rule extends to shared templates). Multi-project run = a fan-out batch (§2.4).
- **Workflow templates** (built-in gallery): "Kullan" instantiates into an owner project and optionally attaches it
  to selected projects in the same dialog (each attach authorized/validated separately). User-authored workflow
  templates are not a new object: an offered shared workflow is the library entry.

---

## 3. Security & RBAC

New actions (`m/src/authz/model.ts`):

| Action | Scope / min role | Notes |
|---|---|---|
| `workflows.share` | owner project / admin | offer to `*` or listed projects; withdraw (existing attachments are not cut, they stop following) |
| `workflows.attach` | target project / admin | attach, detach, overrides, follow/pin; step-up when the version has privileged nodes |
| `workflows.attach.credentials` | target project / admin | bind credential slots; **always-fresh** step-up (like `workflows.egress.write`) |
| `workflows.activate` (existing) | target / operator | per attachment; webhook/GitHub still need `automations.external` + step-up |
| `workflows.run` (existing) | target / operator | run project is a request field |
| `jobs.batch` | each target / operator (= `jobs.create` per project) | no new power, just N checks |
| `templates.share` | owner + `templates.read` in target | |

No escalation across projects:
1. A definition editor in A cannot cause a run in B to use: A's credentials (slots unbound in B), A's repository
   (ignored outside A), A's deploy targets / GitHub repo / egress / execution flags (always the run project's),
   privileged nodes B has not accepted (auto-follow stops at a privileged delta), a lower approver role (overrides
   only raise).
2. A target admin cannot gain A's rights: attachments are read-only views of A's definition; editing needs A.
3. Run-as is always a user of the run's project, re-checked at every fire (unchanged automation rule).
4. Chat: a write tool can only target a project in the thread's set and is authorized there; drafts are confirmed
   per project with step-up rules of that action.
5. Batches: one authorization per project; nothing is aggregated into a broader grant.
6. Visibility: owner's "where used" view lists only projects the caller can read; others appear as a count.

Audit (metadata always has `ownerProject`, `project`, `name`, versions): `workflow.share`, `workflow.attach`,
`workflow.detach`, `workflow.attachment.update` (override diff hash, never values), `workflow.attachment.accept`,
`workflow.attachment.credential` (slot + credential id), `chat.thread.projects`, `job.batch.submit`,
`automation.group.apply`, `template.share`, `template.hide`. Step-up exactly where today's equivalent action has it.

Known existing gap (not widened, not fixed here): any project admin with `workflows.define.network` can reference
any global vault credential id. A project allowlist on credentials is listed as a follow-up (done: [p22-vault-projects](p22-vault-projects.md)).

---

## 4. Data model & migrations (additive; next free numbers at merge time — main is at 0176, p17-chat-flow may
take 0177; renumber on conflict)

1. `workflow_shares (owner_project FK, name, project text CHECK (project = '*' OR id pattern), offered_by, offered_at,
   PK (owner_project, name, project))`.
2. `workflow_attachments (id uuid PK, project FK, owner_project FK, name, state CHECK enabled|disabled|detached,
   follow CHECK auto|pin, version int ≥1, pending_version int NULL, pending_reason text NULL, overrides jsonb object,
   created_by/at, updated_by/at, detached_at NULL, CHECK (project <> owner_project))`;
   `UNIQUE (project, name) WHERE state <> 'detached'`. Own-vs-attached name collisions: service + advisory lock on
   `(project, name)`.
3. `workflow_attachment_credentials (attachment_id FK, slot text, credential_id FK vault_credentials ON DELETE
   RESTRICT, bound_by, bound_at, PK (attachment_id, slot))`.
4. `ALTER TABLE workflow_runs ADD COLUMN attachment_id uuid NULL REFERENCES workflow_attachments`; a new
   `CREATE OR REPLACE FUNCTION workflow_runs_guard()` adds it to the immutable identity (precedent 0103/0106/0112).
   NULL = owner-project run (all existing rows).
5. `automation_groups (id, name, created_by/at)`; `ALTER TABLE automations ADD COLUMN group_id uuid NULL`,
   `ADD COLUMN diverged boolean NOT NULL DEFAULT false`.
6. `chat_thread_projects (thread_id FK ON DELETE CASCADE, project, share boolean, added_at, PK (thread_id, project))`.
7. `job_batches (id, created_by, title, spec jsonb, created_at)`; `job_batch_members (batch_id, project, job_id NULL,
   refusal jsonb NULL, PK (batch_id, project))` — `jobs` is not altered.
8. `job_template_shares (template_id, project | '*')`, `job_template_hidden (template_id, project)`.
9. Notification kind `workflow.update_pending` (widen check like `mig/0103` does).

Backward compatibility: no backfill. Owner-project runs = `attachment_id NULL` + implicit self-attachment; threads
without extras = set {primary}; automations without group, templates without shares behave as today. Rollback:
older code ignores the new tables/columns; shared runs would be invisible to it, not misread (they still carry a
valid `project`).

---

## 5. API, panel, assistant, worker

**API** (all under `/v1`, CSRF + authz as today):
- `PUT /workflows/:id/sharing {projects: ['*'] | string[]}`; `GET /workflows/offers?project=B`.
- `POST /projects/:project/workflow-attachments {ownerProject, name, follow, version?, overrides?}` → 201 + validation
  report (`egress`, `credential_unbound[]`, `privileged[]`, `repository`, `kind`) ; `GET` list;
  `GET|PATCH|DELETE /workflow-attachments/:id`; `POST /workflow-attachments/:id/accept {version}`;
  `PUT|DELETE /workflow-attachments/:id/credentials/:slot`.
- `GET /workflows/:id/attachments` (owner's "where used").
- `POST /workflows/:id/runs` and `PUT /workflows/:id/activation` gain optional `project` (default owner).
  `GET /workflows` returns own + attached per visible project (`attachment` block on each item).
- `POST /workflows/:id/duplicate` gains optional `targetProject`.
- `POST /automations {projects: [...]}` → group; `PATCH /automation-groups/:id {apply: …}`.
- `PUT /chat/threads/:id/projects {projects: [{project, share}]}`; `GET …/knowledge` returns the set.
- `POST /jobs/batches {projects[], spec, perProject?}` → preflight + submit; `GET /jobs/batches/:id`.
- `PUT /templates/:id/shares`, `PUT /projects/:p/templates/:id/hidden`.

**Panel** (`web/`):
- Workflows list: project filter; "Paylaşılan · <sahip proje>" badge; pending-update badge.
- Editor (owner): "Kullanıldığı projeler" tab (project, version, takip/sabit, durum, son çalışma, bekleyen
  güncelleme) + "Paylaş" dialog (tüm projeler / seçili). Save warns "N proje otomatik güncellenecek, M proje onay
  bekleyecek".
- Attachment view (target): read-only canvas + side panel "Bu projedeki ayarlar": etkin, sürüm (takip/sabit,
  güncellemeyi incele: diff via existing VersionsDialog), girdi varsayılanları, depo, gizli anahtar yuvaları,
  tetikleyiciler (cron/saat dilimi, webhook adresi + gizli anahtar, GitHub), onaylayıcı rolü, hata workflow'u,
  saklama süresi. ActivationDialog and run dialog get a project picker.
- Project screen: "Workflowlar" tab — own + attached, "Paylaşılan workflow ekle" picker of offers.
- Automations form: "Projeler" multi-select; detail shows group siblings + "Tümüne uygula".
- Chat: ContextStrip becomes a project set (chips, add/remove, share switch per chip); tool rows and cards show the
  project chip.
- Composer: "Projeler" multi-select → batch; batch page (per-project rows, outputs, PRs, cost).
- Templates: library list with scope chips (genel / bu proje / paylaşılan), share & hide controls, "Projede kullan".

**Assistant** (`packages/protocol/src/assistant.ts`, `m/src/chat/tools.ts`, prompt): `list_workflows` returns
attachments; new draft tools `attach_workflow`, `set_thread_projects`; `run_workflow`/`activate_workflow` take
`project`; `create_job` accepts `projects[]` → batch draft card; write tools enforce project-in-set; prompt block
"Çalışma projeleri" + targeting rule. Workflow AI panel (`chat_threads.workflow_project`) edits only in the owner
project; in a target it explains and proposes "Projeye kopyala".

**Worker**: no change, no worker release. Attachments resolve on the master into ordinary engine-2 runs and JobSpecs;
credential slots resolve to vault ids already sealed to workers (missing seal → existing `credential_missing`);
batches are N ordinary jobs. (Option A for jobs would need one — another reason against it.)

---

## 6. Phasing (each wave shippable and testable alone)

**W1 — Shared workflows core** (master + panel). Resolver `effectiveAttachment(project, name)`; refactor `startRun`
and every `d.project`-as-run-project use (`engine.ts:904+`, `v2/engine.ts` sub/error workflow resolution, trigger
fire path, metrics) to take the run project; tables 1–4; share/attach/detach/accept/credentials API; manual + chat
runs in a target; read-only view; audit.
Acceptance: (a) all existing workflow tests pass unchanged; (b) A offers W, B's admin attaches, B's operator runs it
→ run.project = B, jobs use B's repo/policy/egress/memory, outputs in B; (c) W with an HTTP node: attach refused to
enable until B binds the slot; B's run uses B's credential; A's credential never appears in B's job specs (test);
(d) A adds a privileged node → B stays on old version with `pending_version`, notification sent; non-privileged
change → B advances; pinned B never moves; (e) B's viewer without offer cannot read W; (f) collisions refused;
(g) archive in A stops new runs in B.

**W2 — Per-project triggers & settings.** Activation per attachment (own automation, webhook URL/secret, cron + TZ
override, GitHub repo), approver-role raise, error workflow / retention per project, concurrency per
`(project, name)`, owner "where used" view, pending-update review screen.
Acceptance: two projects attached to W each have distinct webhook URLs; firing B's URL starts a B run only; B's
error workflow (own name) runs on B failure; retention pruning uses B's value; approver override can't lower.

**W3 — Chat project set** (after p17-chat-flow merges). Table 6, knowledge/sharing per member, tool targeting rules,
prompt block, chips on rows and cards, `attach_workflow` / `set_thread_projects` drafts.
Acceptance: a thread with A+B: "A'daki işleri listele" reads A only; a write without project is refused and the
assistant asks; sharing off for B → no B project vectors; removing B's access drops it.

**W4 — Automation groups + template library.** Tables 5, 8; multi-project automation form, apply-to-all with
divergence; job template shares/hidden; workflow template "Kullan" with attach.
Acceptance: creating a cron automation for A, B, C where the user lacks C → two created, C listed refused; apply-to-all
skips a sibling the editor can't change and marks it diverged; a shared template appears in B, hidden in C.

**W5 — Job fan-out batches.** Table 7, `/jobs/batches`, composer multi-select, batch page, chat batch draft card.
Acceptance: one submission to A, B (held), C → jobs in A and C, B refused with `project_held`; each job under its own
project policy, PR and deploy; batch page shows 2/3 with costs.

---

## 7. Open questions for the owner (with recommendation)

1. **Ownership of a shared workflow**: owner project (+ an optional ordinary "ortak" project as a library) vs a
   separate library scope with admin-only editing. → *Owner project.*
2. **Updates in attached projects**: auto-follow non-privileged changes (pin optional) vs every new version needs the
   target admin's acceptance. → *Auto-follow non-privileged; privileged changes wait for acceptance.*
3. **Who may attach**: two-sided (owner offers, target admin attaches) vs any target admin may attach any workflow
   they can read. → *Two-sided, with "tüm projeler" offer for convenience.*
4. **Multi-project jobs**: fan-out batch vs one multi-repo job. → *Fan-out; multi-repo out of scope.*
5. **Chat write targets**: only projects in the thread's set vs any project the user can access. → *Only the set;
   adding a project is one click or a confirmed card.*

---

## 8. Risks and out of scope

Risks:
- Hidden "definition project = run project" assumptions (archive, kind, repository fallback, concurrency/streak
  keys, metrics, payload access checks, `workflowResource` authz). Mitigation: W1 starts with the resolver refactor and
  a grep-driven checklist; a test that runs every node type in a target project.
- Owner edits silently changing behaviour in many projects (non-privileged AI prompt changes). Mitigation: save
  dialog shows the blast radius; targets can pin; audit + version diff.
- Name collisions and confusing duplicates — refused, with "Projeye kopyala" as the escape.
- Cost fan-out: one shared trigger change can start runs in N projects — each charged and capped by its project's
  quota/cost brake; the owner view shows aggregate runs.
- Disclosure: target viewers read the owner's definition (consented by the offer); owner sees only aggregate counts
  of projects it cannot read.
- p17-chat-flow overlap in chat cards — W3 waits for its merge.

Out of scope: per-step target projects; project-less org workflows; cross-project sub-workflows; multi-repo jobs and
atomic cross-repo changes; bulk approvals across a batch; project-scoped vault ACL (follow-up); aliases for attached
names; user-authored workflow-template objects; converting existing duplicate workflows into one shared workflow;
global security policy changes.

## Owner decisions (2026-10-28)

1. A shared workflow lives in its owner project (no separate library scope); others attach it or "Projeye kopyala".
2. Updates: non-privileged changes follow automatically; a version that adds or changes a privileged node (network, deploy, code) waits for the target admin's acceptance with step-up; any attachment may pin.
3. Attaching: the owner project's admin offers (listed projects or "all projects"), the target project's admin attaches.
4. Multi-project jobs: fan-out — one ordinary job per selected project, grouped as a batch.
5. Chat write tools target only the thread's project set (recommendation taken; not asked separately).

## 9. Built: W1 + W2 (2026-10-28)

Branch `p18-shared-workflows`. Migration **0178** (`0178_shared_workflows.sql`). No worker release (no protocol, tool or
prompt change).

**Data model (as §4 items 1–4 and 9).** `workflow_shares (owner_project, name, project | '*')`;
`workflow_attachments` (state `enabled | disabled | detached`, follow `auto | pin`, `version`, `pending_version` +
`pending_reason` `privileged | inputs | privileged_inputs`, `overrides` jsonb, `UNIQUE (project, name) WHERE state <>
'detached'`); `workflow_attachment_credentials (attachment, slot → vault credential, ON DELETE RESTRICT)`;
`workflow_runs.attachment_id` (NULL = owner-project run; added to the immutable identity of `workflow_runs_guard()`,
rewritten from 0112); notification kind `workflow.update_pending`.

**Resolver.** `m/src/workflows/sharing.ts`: `resolveName(project, name)` = the project's own workflow (latest version —
the implicit self-attachment, no row) else its live attachment (the attachment's version); `attachmentOf(project,
owner, name)`; `slotBindings(attachment)`. The pure part (`sharing-model.ts`): the overrides schema
(`AttachmentOverrides`: `inputs`, `repository`, `approvers`, `onFailure`, `retentionDays`, `triggers` (cron / time
zone, GitHub repository / events / branches), `concurrency.max`), `effectiveDefinition` (approver roles only raise,
concurrency only lowers, settings replaced, trigger configs overridden, the owner's `defaults.repository` dropped
outside the owner project), `overrideIssues`, `credentialSlots`, `newRequiredInputs`, `withInputDefaults`.

**Refactor checklist — every place that assumed "definition project = run project".**

| Place | Before | Now |
| --- | --- | --- |
| `engine.ts` `startRun` | run project, archive check, project kind, repository fallback, spec checks, routing, delegation all from `d.project` | `input.project` (default owner); another project needs its live **enabled** attachment, runs the attachment's version (a re-run keeps its source's), every credential slot bound; archive check on the owner (stops runs everywhere); kind / repository (`run input ?? override ?? run project's registered`, never the owner's) / specs / routing / delegation from the run project; `attachment_id` stored (both engines) |
| `v2/engine.ts` `startRun` | concurrency lock + group, insert, step specs, `$run.project` from `s.definition.project` | `StartRunV2.project` + `attachmentId` |
| `v2/engine.ts` `#definition` | the stored document | + the attachment's overrides (`effectiveDefinition`) — gate roles, error workflow, timeout, concurrency |
| `v2/engine.ts` function nodes | credential id used as is | resolved through the run's slot bindings (`credential_unbound` otherwise, never retried) |
| `v2/engine.ts` `promoteQueued` | definition's `concurrency.max` | the attachment's lowered max |
| `engine.ts` `#startChild` (sub-workflow) | `(project, name)` own definitions only | `resolveName` in the run's project (own or attached; a pinned version must be the attached one); cross-project still refused |
| `engine.ts` `#startErrorRun` | `(project, name)` own only | `resolveName` in the failed run's project; the error workflow comes from the attachment's override |
| `engine.ts` `rerun` (latest version) | owner's latest | the version the run's project runs now |
| `engine.ts` `metrics` | owner's runs | `?project=` the runs of an attaching project |
| `engine.ts` `list` | own definitions | + attached ones per visible project (`attachment` block; `id` = the version it runs) |
| `engine.ts` `define` | — | a new own name that is attached in the project → `name_taken`; after the save the attachments follow / wait (`onOwnerVersion`) |
| `engine.ts` `duplicate` | same project | `targetProject` ("Projeye kopyala"), owner repository dropped |
| `v2/ops.ts` `runsDueForPruning` | definition → project → default | attachment `retentionDays` first |
| `v2/respond.ts` `holdOf` | binding → own definition | binding → attachment version |
| `triggers.ts` | bindings of the owner | `project` = an attaching project: its version, its trigger overrides, its own automations (`workflow_trigger_bindings (project, name, node)`), no pin (the attachment's line decides); `pauseProject` for detach |
| `automations/service.ts` | workflow target must be the automation's project's; bound fire = binding project's definition; run in the definition's project | attached workflows allowed as targets; bound fire = the attachment's version; `startWorkflow` passes `project: a.project`; chain sources may be attached names |
| `workflows/routes.ts` resources | `workflowResource` = owner | `workflowTargetResource`: `?project=` / body `project` (/ `targetProject`) decides in the attaching project — runs, activation, definition (an offered, not yet attached workflow only for the target's admins), versions (up to the run / pending version), metrics, duplicate; define / archive / share / test stay owner-only |
| `composer/routes.ts` `GET /workflows/:id` | owner | `?project=` (repository shown as the target's) |
| unchanged on purpose | integrations, egress, memory, outputs, approvals, quotas, run-as re-checks — already keyed on `run.project` | |

**Behaviour.**
- Offer (`PUT /workflows/:id/sharing`, `workflows.share`, owner admin, step-up): listed projects or `*`; withdrawing
  keeps attachments, they stop following. `GET /workflows/:id/sharing`.
- Attach (`POST /projects/:project/workflow-attachments`, `workflows.attach`): only offered, not archived, no name
  collision (same advisory lock as `define`); the version's privileged nodes need the target's `workflows.define.*` and
  a fresh step-up; answers a report (kind, repository, egress against the target's policy, unbound slots, privileged
  nodes, blocking issues). With unbound slots the attachment starts `disabled`.
- Follow: after an owner save, each `auto` attachment with the offer in force moves to the new version when
  `privilegedDelta(version, new)` is empty and no new required input lacks a default override; otherwise
  `pending_version` is set and the target's admins get `workflow.update_pending` (link `/workflows/<id>?project=`).
  Pinned attachments never move. The save answer lists `attachments: {advanced, pending, pinned}`.
- Accept (`POST /workflow-attachments/:id/accept {version}`): any version of the owner's line; privileged delta →
  define.* actions + fresh step-up; an enabled attachment needs the version's slots bound.
- Credentials (`PUT|DELETE /workflow-attachments/:id/credentials/:slot`, `workflows.attach.credentials`, always-fresh
  step-up): the credential must be active, of the slot's kind and bound to every host the slot's nodes call. Enabling
  needs every slot bound; unbinding a needed slot disables. Audit metadata `slot` + `boundVaultId` (keys named
  `credential…` are redacted by the audit log).
- Detach (`DELETE /workflow-attachments/:id`): row kept (run history), bound automations of the project paused, name
  free again. Owner archive: no new run in any project (`workflow_archived`), attachments show `ownerArchived`.
- Visibility: an owner's workflow is invisible to a project without an offer; offered → only the target's admins may
  preview; attached → the target's viewers read the versions up to the one it runs / has pending.
- "Nerede kullanılıyor" (`GET /workflows/:id/attachments`): attachments of projects the caller reads, the rest as a count.
- Audit: `workflow.share`, `workflow.attach`, `workflow.detach`, `workflow.attachment.update` (overrides hash),
  `workflow.attachment.accept`, `workflow.attachment.follow` / `.pending` (system), `workflow.attachment.credential`,
  run starts with `ownerProject` + `attachment`.

**Panel.** Workflows list: `Paylaşılan · <owner>` pill, pending / disabled pills, links and runs through the project,
row menu Bu projedeki ayarlar / Projeye kopyala; `Paylaşılan workflow ekle` (offers of an administered project).
Editor: `?project=` opens the attachment view read-only with **Bu projedeki ayarlar** (state, follow / pin, accept the
pending version or move a pinned one, credential slots with the vault's credentials, input defaults, approver roles
offering only higher roles, schedule / zone / GitHub repository, error workflow, retention, concurrency, repository,
detach, copy); triggers, versions, runs and metrics of that project. Owner editor: **Paylaş** (none / all / selected)
with **Nerede kullanılıyor**; the saved notice tells how many projects followed or wait. Composer: an attached
workflow is read and run through the draft's project.

**Tests.** `test/integration/workflow-sharing.test.ts` (acceptance W1 a–g incl. engine 1, W2: distinct webhook URLs
and a B-only run, B's error workflow, B's retention, approver raise-only), `test/unit/workflow-sharing-model.test.ts`,
RBAC matrix fixtures (`/workflow-attachments/*`, `/workflows/offers`), web `test/p18-shared-workflows.test.tsx`.

**Not done (later waves / follow-ups).** W3–W5. The assistant does not list or run attached workflows (`list_workflows`,
`draft_workflow_run` take the owner project — W3 with the thread's project set). The workflow AI panel is hidden in the
attachment view. Save does not warn *before* saving ("N follow, M wait"); it reports after. A version that changes a
trigger node's configuration still follows; the target's bound automation keeps its configuration until the target
activates again (shown as "out of date"). Vault credentials are not project-scoped (any project admin can name any
global credential, in an own workflow or a binding) — tracked in bilinen-eksikler.

## 10. Built: W3 + W5 (2026-10-28)

Branch `p18-multi-project-w3`, migration **0184** (`0184_multi_project_chat_jobs.sql`). Owner: "hepsini tamamlayalım".
Also closes the project chips of p18-plan-mode W4 (backlog `p18-plan-mode-w4-projects`). **Worker release: yes**
(bundled with 1.2.1): feature `assistant-projects-v1` — the tools `set_thread_projects`, `attach_workflow`,
`draft_job_batch`, `draft_workflow_run.project`, `list_workflows.offers` and prompt rule 54. Master and web work without
it (the project set in the header, the knowledge rules, the batch pages and REST); the write rules are applied only for
turns on such a worker (an older one cannot name projects it does not know about).

**Data (0184).** `chat_thread_projects (thread_id → chat_threads ON DELETE CASCADE, project → projects ON DELETE
CASCADE, share, added_by, added_at, PK (thread_id, project))`; `job_batches (id, created_by, title, spec ≤ 64 KB,
source console | chat, thread_id, draft_id, created_at)`, `job_batch_members (batch_id, project, position, job_id NULL →
jobs ON DELETE SET NULL, refusal jsonb NULL, PK (batch_id, project))` — `jobs` is not altered; draft kinds
`thread_projects`, `workflow_attach`, `job_batch`. Additive (rollback in the migration header).

### W3 — the conversation's working projects

- **The set** = `chat_threads.project` (the primary, its switch stays `project_share`) ∪ `chat_thread_projects` (in the
  order added), at most 8 (`MAX_THREAD_PROJECTS`). `m/chat/thread-projects.ts`: `normaliseSet` (ids, no duplicates, a
  member's switch defaults to its current value, else on), `set` (every member must exist and be readable by the
  caller — any project role; the whole set at once, the first is the primary; the advisory lock of the knowledge
  writes; members that leave or stop sharing lose this conversation's project vectors in the same transaction; audited
  `chat.thread.projects` with before / after ids and switches, `source` console | chat), `forTurn` (members the user
  can no longer read are dropped — the next member becomes the primary — with a tool-row notice in the conversation and
  an audit `source: access_lost`), `workingProjectsBlock`.
- **REST**: `GET|PUT /chat/threads/:id/projects {projects: [{project, share?}]}` (owner of the conversation; 400
  `too_many_projects` / `bad_request` (reason thread_projects), 404 `project_not_found`); `GET /chat/threads/:id`
  knowledge and `PUT …/knowledge` answer `projects: [{project, name, kind, role, share, primary}]`. The old single
  project route keeps working (changing the primary to a member removes it from the extras).
- **Knowledge** (`search/chat-knowledge.ts`): every member links the messages like the primary (`computeLinks` takes the
  set); `projectChatEligible` and the insert re-check use the member's own switch (a project outside the set — a
  mention, a draft — still follows the primary's switch); the header reasons (`thread_off`) are per member; the
  related-knowledge lookup searches every member, then @mentions (up to 8 projects).
- **The turn** (`m/chat/service.ts`): the "Çalışma projeleri" block (id, name, kind, the user's role, primary, sharing;
  the rule: every action says its project; with several, writes name one, ask with ask_user when unclear) is sent when
  the answering machine has `assistant-projects-v1`, or always when the set has several members (data either way).
  ToolCaller gets `projects` and `projectRules` (the feature) once per turn.
- **Write rules** (`m/chat/project-set.ts`, applied in `ChatTools.run` before the tool runs, only with `projectRules` and
  a non-empty set): a `draft` tool whose `project` (draft_job_batch: any of `projects`) is outside the set →
  `project_not_in_thread` (the message tells the model to ask, or to add it with set_thread_projects when the user's
  request names it); `set_thread_projects` is exempt. Plan tools: an item's project outside the set →
  `project_not_in_thread`; a job / workflow item without a project when the set has several → `project_required`.
  Tools whose project comes from an object (a job's action, a run's cancel) are not targeted: the object decides and the
  card is authorized there as before.
- **Shared workflows in the chat** (`m/chat/workflow-read.ts`): `list_workflows` adds the live attachments of the
  readable projects (first page) as items of the ATTACHING project with `attachment {ownerProject, state, follow,
  version, pendingVersion, runnable}` and a `?project=` link; without `project` and with several working projects it
  lists only those; `offers: true` adds `offered[]` (offered to the working projects, not attached, not archived, with
  `canAttach`). `describe_workflow` is readable through an attachment (read-only: versions up to the attached one, the
  attaching projects' runs, `attachedIn[]`). `draft_workflow_run.project` = the run project: an attached workflow runs
  there (enabled attachment, its version, the owner's `defaults.repository` dropped); without `project`, with the rules:
  the one working project that has it (own or enabled attachment), several → `project_required`, none →
  `project_not_in_thread`. The confirmed card passes `project` to `startRun` (W1 resolves the attachment, its version,
  overrides and credentials).
- **Cards** (`m/chat/multi-project-actions.ts`, the console's services for the confirming user): `thread_projects`
  (set_thread_projects → ThreadProjects.set, event chat.cards; the conversation's stream gets the thread);
  `workflow_attach` (attach_workflow → SharedWorkflowService.attach with the card's step-up; the tool checks the offer,
  `workflows.attach` in the target, name collisions and the report first — privileged nodes and unbound credential slots
  are on the card; event `workflows.privileged` like the attach route).
- **Panel**: the context strip shows the set as chips (primary first and marked "ana"; a dot = this member's
  "Proje bilgisiyle paylaş", tap to switch; ★ makes a member the primary; × removes; "+ Proje ekle" picks a readable
  project; at most 8); a conversation without projects keeps the classic "Projeye bağla" line. The new-chat picker
  takes a primary and then "Başka proje ekle" (the conversation is created with the whole set). Cards: kind pills and
  facts for the three new kinds (tr + en), a shared run names its owner ("Paylaşılan workflow · sahibi A"), result links
  to the batch / the attachment.

### W5 — job fan-out batches

- `m/jobs/batches.ts` `JobBatchService`: `plan` (preflight, no side effects) per project: `jobs.create` for the
  submitter (`forbidden` / `not_found`), allow-all / unconfined only where the project allows them
  (`full_access_not_allowed`), a repository project needs its registered repository (`repository_missing`), the
  composer's admission preview: the quota kill switch → `project_held`, a budget at 100 % (or incomplete under the block
  policy) → `budget_exceeded`; concurrency limits only make a job wait (`waits`). The spec is an ordinary job of that
  project: `{{project.id}}` / `{{project.name}}` in the prompt, the project's extra instructions appended, its
  repository (own base branch or the project's) and a fresh work branch, or its workspace; the project's defaults
  (sandbox, approval policy, limits — `ProjectDefaults.apply` like the composer); JobSpec-checked. `submit` preflights
  again now, writes the batch, creates each job in its own transaction through the job store (one project's failure is
  that project's refusal), dispatches, records members (job or refusal) and audits `job.batch.submit` (projects, created
  job ids, refused codes — never the prompt). `get` (creator; owners / admins any) shows per member the job's state,
  title, cost (`usage_records`), PR (`job_git.pr_url`) — only for projects the reader can read — the refusal, counts,
  total cost and the batch state (running / done / failed / refused).
- REST (`m/jobs/batch-routes.ts`): `POST /jobs/batches/preflight`, `POST /jobs/batches` (operator+; each project
  authorized on its own), `GET /jobs/batches`, `GET /jobs/batches/:id`.
- Chat: `draft_job_batch` (2–8 projects of the set) → the `job_batch` card holds only the projects that passed the
  preflight plus the refused list; confirming submits the batch for the confirming user (a batch where no project could
  take the job is refused 409 `batch_refused`, the card stays open). A plan item linked to the card (`planItem`) follows
  the batch: link kind `batch` (added when the card is confirmed), done when every created job succeeded, blocked when
  one failed ("1/2 jobs failed"), in progress otherwise.
- Panel: `/jobs/batches` (list; "Toplu işler" on the Jobs screen), `/jobs/batches/new` (projects, title, prompt, runtime
  → **Kontrol et** shows ready / waits / refused per project → submit), `/jobs/batches/:id` (per project the job's state,
  PR, cost and "İşi aç", or the refusal; total cost; refreshes while running).

**Security.** No new authority: the set only narrows where the assistant may write; each card is authorized for the
confirming user in its project as before (`tools.ts #can`, `DraftExecutor`), attach keeps the route's rules
(offer, admin, privileged step-up), a batch is N `jobs.create` checks and N ordinary jobs under their own project's
policy, quotas, approvals and deploys (no aggregated grant, no multi-repository job). The batch page hides jobs of
projects the reader cannot read. Read scoping without a project is a convenience, not a boundary (the tools still
authorize per project).

**Tests.** Protocol `test/assistant-projects.test.ts`; agent adapters `test/assistant-projects.test.ts` (rule 54);
master unit `test/unit/multi-project-w3.test.ts` (set rules, targeting matrix, plan rule, links of every member, batch
preflight with fake rows / holds / defaults, batch state, derived status of a batch link, events); master integration
`test/integration/multi-project-w3.test.ts` (REST set + audit + limits + access loss, write refusal and a confirmed
set_thread_projects card, plan project_required, acceptance W5 A / B held / C → 2/3, the chat batch card) and the RBAC
matrix fixture for `/jobs/batches/:id`; web `test/p18-multi-project-w3.test.tsx`.

**Not done.** W4 (automation groups, template library) — built since, §11. The composer's "Projeler" multi-select (a dedicated
`/jobs/batches/new` form instead); per-project overrides beyond prompt / base branch. Reads without a project are
scoped to the set only by `list_workflows` (other read tools keep listing every visible project). The workflow draft
card's "projelere ekle" button (attach after saving) — use attach_workflow. Chips on tool rows (draft cards show their
project as before).

## 11. Built: W4 (2026-10-28)

Branch `p18-multi-project-w4` (off `p18-multi-project-w3`), migration **0185** (`0185_automation_groups_template_library.sql`).
Owner: "hepsini tamamlayalım". **Worker release:** only for the chat part, in the same 1.2.1 release and feature as W3
(`assistant-projects-v1`: `draft_automation.projects`, one sentence of prompt rule 54). The console and REST work without
it; the master drafts a group card only for a turn on such a worker.

**Data (0185, §4 items 5 and 8).** `automation_groups (id, name, created_by/at, updated_by/at)`;
`automations.group_id → automation_groups ON DELETE SET NULL`, `automations.diverged boolean`; `job_template_shares
(template_id → job_templates ON DELETE CASCADE, project | '*', shared_by, shared_at)`; `job_template_hidden (template_id,
project → projects, hidden_by, hidden_at)`. Additive (rollback in the migration header): an older master ignores them
(grouped automations keep working one by one; shared templates are simply invisible outside their project).

### Automation groups (§2.2)

- `m/automations/groups.ts` `AutomationGroupService`. **Create** (`POST /automation-groups`, `automations.write` + step-up,
  body = the automation input with `projects[]` (2–20) instead of `project`): a group row, then per project an ordinary
  `AutomationService.create(…, {groupId})` — authorized there (`project_not_found` for a project the caller cannot read,
  `forbidden` without the operator role; GitHub / webhook triggers keep needing that project's admin) and validated there;
  every refusal is listed `{project, code, message}`; nothing created → 409 `group_refused` (the empty group is removed).
  Webhook secrets are returned once per created automation. Audit `automation.group.create` (projects, created ids,
  refused codes).
- **Per-project adaptation** (`adaptForProject`, the only thing a group adds): a job target's repository becomes the
  project's registered repository (fresh work branch; none for a workspace project; `repository_missing` otherwise),
  `spec.projectId` is the project; a workflow target names its workflow by name — each project runs its own workflow of
  that name or the one it attached (W1 `resolveName`), never another project's (`workflow_not_found`); a GitHub trigger
  listens to the project's registered GitHub repository. Deploy targets, output folders, chain sources and input files
  are validated in each project as they are.
- **Tümüne uygula** (`PATCH /automation-groups/:id {patch}`, `automations.write` + step-up): the patch goes through
  `AutomationService.update(…, {group: true})` for every live sibling the editor may change (same rules, same step-up);
  a sibling in a project the editor cannot change (no operator role, a webhook / GitHub trigger without its admin, a
  validation error there) is left unchanged and marked `diverged` — listed with its reason, or counted (`hiddenSkipped`)
  when the editor cannot read its project; stored input files stay each sibling's own. A sibling changed on its own
  (`PATCH /automations/:id`) is marked diverged; the next apply-to-all aligns it (`diverged = false`). Audit
  `automation.group.apply` (fields, applied ids, skipped `project:code`).
- **Read:** `GET /automation-groups/:id` — the siblings in the projects the caller reads (state, trigger, diverged,
  `canEdit`), the others as a count; 404 when it reads none. Every automation view carries `group {id, name, size,
  diverged}`; `GET /automations?group=`.
- A group is never an authority: every row keeps its project's run-as, external-trigger and chain rules (re-checked at
  every run as before). Workflow trigger automations of shared workflows are not grouped (the attachment is their group).

### Template library (§2.5)

- **Shares** (`PUT /templates/:id/shares {projects: ['*'] | string[]}`, new action `templates.share` — the template
  project's operators, like `templates.write`): every listed project must be readable by the caller (else 404); never
  the template's own project, never `*` with others (`invalid_shares`), not for global templates; a template whose
  defaults are full access ("Never ask" / unconfined) cannot be shared, and a shared template cannot be changed to full
  access (`full_access_shared`, the `full_access_global` rule extended). Withdrawing removes the rows. Audit
  `template.share` (projects, withdrawn).
- **Visibility:** global, readable in its own project, or shared to a project the caller reads (`*`: anyone who reads a
  project). Route authorization of reads (`GET /templates/:id`, versions, diff, render, automations from a template)
  takes `?project=` / body `project` = a project the template is shared to and checks the action there; without it the
  template's own project. Editing, archiving and sharing stay with the owner project.
- **Use in a project:** `render` / `recordRun` / `automations` accept a project the template is shared to; there the
  target's policy caps the run — never full access (`full_access_shared`), file parameters only in a workspace project,
  the owner's `baseRef` dropped (the target's base branch). "Projeye kopyala": `POST /templates/:id/duplicate {project}`
  needs `templates.write` in the copy's project and read access to the template.
- **Hidden** (`PUT /templates/:id/hidden {project, hidden}`, `templates.write` in that project): a global or shared
  template disappears from that project's library; the project's own templates are archived instead
  (`template_own_project`). Audit `template.hide`. Hiding is a library preference, not a ban (a direct render still
  works).
- **List:** `GET /templates?project=P` = what can run in P — P's own, global and shared ones, minus those P hid
  (`hidden=include|only`). Every view carries `scope` (`global | project | shared`), `sharedTo` (readable ones / `*`),
  `sharedToHidden` (count), `canShare`, `hidden`.
- **Workflow templates:** `POST /workflows/templates/:id/instantiate {attachTo[]}` — before anything is saved the
  owner project's `workflows.share` and a fresh step-up are required; projects the caller cannot read (or that do not
  exist) and projects where it lacks `workflows.attach` are refused up front; the new workflow is offered to the rest
  (`setSharing`) and attached in each (`attach`: privileged nodes need the target's define.* rights; with credential
  slots the attachment starts disabled). The answer lists `attached` / `refused`.

### Panel

- Automation form: **Başka projelerde de oluştur** (projects the user works in, never the primary) → the result page lists
  the created automations (and each webhook secret once) and the refused projects with their reason; editing a grouped
  automation: **Tümüne uygula (N otomasyon)** → applied count, skipped (diverged) siblings with reasons. The list and the
  automation page show a **Grup · N proje** pill (amber when diverged); the automation page has the **Proje grubu** panel.
- Templates: the list's **Kütüphane** (a project) with **Kapsam** (Tümü / Bu proje / Genel / Paylaşılan) and **Gizlenenleri
  de göster**; pills *Paylaşılan · owner*, *N projeyle paylaşılıyor* / *Tüm projelerle paylaşılıyor*, *Gizli*; rows link
  with `?project=`. The template page: a **Kütüphane** tab (owner: Paylaşım — none / every project / selected projects;
  in another project: the shared note and *gizle / yeniden göster*), a shared template runs in a project it is shared to
  (picker) and **Çoğalt** copies it into the viewed project.
- Workflow template wizard: **Başka projelere de ekle** (only when the user administers the owner project; only projects
  it administers) → a result page with each project's attachment (link to *Bu projedeki ayarlar*) or its refusal.

### Assistant

- `draft_automation.projects` (2–8 working projects; new automations; not with GitHub / webhook triggers): each project is
  checked like a single draft (operator role, the project's spec through the composer defaults, `adaptForProject`,
  `AutomationService.validate`); refused projects are left out of the card and listed; fewer than two ready → the model
  is told to draft for one project. The card (`automation`, `action: create_group`) confirms through
  `AutomationGroupService.create` for the confirming user (each project checked again); the result links the first
  automation (its page shows the group). The working-project rule covers every project of `projects`.
- Data only (no worker needed): `list_automations` items carry `group`, `list_templates` items `scope` / `sharedTo`;
  `list_templates {project}` and `draft_from_template {project}` see and run shared templates of that project.

**Tests.** Master unit `test/unit/multi-project-w4.test.ts` (per-project adaptation, create refusals, apply skipping and
divergence, `usableIn`, share / hide inputs, `templates.share`, the chat write targets); master integration
`test/integration/multi-project-w4.test.ts` (acceptance: A, B, C without C → two + C refused; apply-to-all skips and marks
a sibling diverged, a sibling changed alone diverges and is re-aligned; a shared template in B, hidden in C, read /
rendered only through B, copied into B, full access never shared; the chat's group card) and an added case in
`test/integration/workflow-templates.test.ts` ("Kullan" with `attachTo`); RBAC matrix (`templates.share`,
`/automation-groups/:id`); protocol `test/assistant-projects.test.ts`, agent adapters `test/assistant-projects.test.ts`
(rule 54); web `test/p18-multi-project-w4.test.tsx`.

**Not done.** Adding a project to an existing group (create a new group); group-wide pause / resume / delete (per
automation); GitHub / webhook triggers in the chat's group card (one project at a time, each needs its admin);
apply-to-all never copies input files.

**Leftovers (2026-10-28, [p18-leftovers](p18-leftovers.md)).** Built: `POST /automation-groups/:id/projects` ("Projeye
ekle": a sibling's configuration in new projects, step-up, refusals listed), `POST /automation-groups/:id/pause|resume`
and `DELETE /automation-groups/:id` (each sibling through the single action, the ones the caller may not change listed),
the panel's **Tüm grup** actions; the chat's group card takes a GitHub trigger on worker 1.2.2 (each project's admin).
Still by design: webhook triggers stay one project at a time in the chat (one secret per project, a card reveals one);
apply-to-all and "Projeye ekle" never copy input files. The composer's "Projeler" (W5 "Not done") is built too: a job
that starts now goes as a batch to the picked projects (`web/screens/composer/batch.tsx`).

