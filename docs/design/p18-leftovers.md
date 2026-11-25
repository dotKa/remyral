# p18-leftovers — the open items of the 2026-10-28 waves

Owner 2026-10-28: "geliştirmelere devam et hepsini tamamla". Branch `p18-leftovers` (off main), migration **0187**
(`0187_chat_plan_search.sql`; 0186 belongs to the IDE W2 wave). **Worker release:** only for the chat part, the next
worker version **1.2.2**, feature **`assistant-budgets-v1`** (`draft_budget_change`, prompt rule 55, a GitHub trigger in
the chat's automation group card). The console and REST work without it; the master answers `draft_budget_change` and
takes a group card's GitHub trigger only for a turn on such a worker.

Paths: `m/` = `apps/master/src/`, `web/` = `apps/web/src/diyalog/`, `proto/` = `packages/protocol/src/`, `aa/` =
`packages/agent-adapters/src/`.

## 1. Automation groups (p18-multi-project §11 "Not done")

- **Projeye ekle** — `POST /automation-groups/:id/projects {projects[1–20], from?}` (`automations.write` + step-up, the
  default JSON limit: no input files travel). The configuration of a reference sibling (`from`, a live sibling the caller
  reads; else the first live one that did not diverge, else the first one) becomes an `AutomationInput` for each new
  project (`inputOfDetail`: trigger, target, policies, enabled = the sibling's state; **not** its stored input files, its
  output folder, a fixed continue-from job or a deploy-on-success approval — they belong to one project / one approval),
  adapted with `adaptForProject` and created through `AutomationService.create(…, {groupId})` exactly like
  `POST /automation-groups`: authorized and validated in that project, refused ones listed (`project_not_found`,
  `forbidden`, a validation code), a project that already has a live sibling `already_in_group`, never more than 20
  (`group_full`). Webhook secrets are returned once. Audit `automation.group.add_projects` (from, projects, created ids,
  refused `project:code`).
- **The whole group in one action** — `POST /automation-groups/:id/pause`, `POST /automation-groups/:id/resume`,
  `DELETE /automation-groups/:id` (`automations.write`). Every live sibling the caller may change goes through the single
  action (`AutomationService.pause / resume / remove`: same state rules, same audit entry per automation); a sibling in a
  project where the caller lacks the operator role, or one the service refuses, is listed `{id, project, code,
  message}`; one already in the asked state is `unchanged`; siblings in projects the caller cannot read are left alone
  and counted (`hiddenSkipped`). Step-up as the single ones: none for pause and delete; resuming a GitHub / webhook
  sibling needs that project's admin and a fresh code — when such a sibling would resume and the session has no fresh
  code the whole request answers `403 step_up_required` once (the console asks for the code and retries) instead of
  listing each. Audit `automation.group.pause|resume|delete` (done ids, unchanged count, skipped `project:code`, hidden
  count). The group row stays (deleted automations keep pointing at it); `GET` answers 404 once no live readable sibling
  is left.
- **Panel** (`web/screens/automations/GroupParts.tsx`): the automation page's **Proje grubu** panel has **Tüm grup** —
  **Projeye ekle** (projects the user works in that are not in the group yet → step-up → created / refused list, webhook
  secrets once), **Tümünü duraklat**, **Tümünü sürdür** (step-up when the master asks), **Tümünü sil** (a confirmation
  dialog) — each with its result (n of total, the ones not changed with their reason, the hidden count).
- **The chat's group card** (`draft_automation` `projects`): a **GitHub** trigger is taken on worker 1.2.2 — each project
  needs its admin (checked when drafting: a project without it is left out with the reason; checked again by
  `AutomationService.create` when the card is confirmed with the card's own step-up, `automations.manage`), and listens to
  that project's registered repository (`adaptForProject`). A **webhook** trigger stays one project at a time: every
  automation gets its own secret that is shown once, and a confirmed card reveals one secret only. Older workers keep
  the W4 refusal.

## 2. Hidden templates — list only (skipped by decision)

The W4 note says: "Hiding is a library preference, not a ban (a direct render still works)". Read that way, the library
paths that list a project's templates (the Şablonlar list's **Kütüphane** = `GET /templates?project=`, the chat's
`list_templates {project}`) already leave a hidden template out; running a template by its id (the template page,
`render`, `draft_from_template` with an id the user named) stays allowed on purpose, and lists without a project (the
chat composer's template picker, the command palette) are not a project's library. Nothing changed.

## 3. Budgets through the chat

- Tool **`draft_budget_change`** (`proto/assistant.ts`, worker 1.2.2): `action create | update | delete`, `budgetId`, the
  fields of the console's budget form (name, metric, limit, window, scope, enabled, billing, timeZone, thresholds,
  onExceeded). An administration card (`settings_change`, target "admin") planned and run by `m/chat/ops-tools.ts`:
  - planning: `budgets.write` (administrators, globally — like the route, no project in the payload), the usage store's
    own input checks (`UsageStore.checkBudgetInput` = the private `validateBudget`) so an invalid card is never shown,
    update = the current budget with only the named fields changed, `expectedVersion` of the budget the card showed;
  - confirming: `UsageStore.createBudget / updateBudget / deleteBudget` for the confirming user with the step-up the card
    confirmation left (`OpsApplyContext.human`: a fresh code, or "now" when the security policy waives the event) — the
    store re-checks role and step-up and writes its own `usage.budget.*` audit entry (`source: chat`);
  - event `limits.budgets` (the console route's), ops `budget.create|update|delete` → `budgets.write`.
- **A card by default for loosening** (`budgetLoosens`): a higher limit, switched off, a weaker `onExceeded`
  (`pause_new` > `block_automations` > `warn`), a longer window, another metric / scope / billing, deleting an enabled
  budget. Such a card carries `cardOnly: 'default'` in its hash-protected payload: `ChatDirectActions` runs it directly
  only on the user's explicit request (`execute: true`) — never by the platform's default, a watch or an autonomous plan
  (audited `chat.direct_action` denied, reason `card_only`). The card says so (`admin-card-loosens`).
- Prompt rule **55** (`aa/assistant.ts`): read `quota_status` first, change only what the user asked, loosening stays a
  card unless explicitly asked, never loosen a budget to let a held job run.
- The off-site backup target stays browser-only by design (no change).

## 4. Plans

- **Plan texts in the meaning search** (`GET /chat/search`). Migration 0187: `chat_plan_embeddings` (owner-only vectors
  of a plan's text, like `chat_embeddings` scope `user`) and `chat_plans.search_synced_at`. The chat pass
  (`m/search/chat-knowledge.ts #indexPlans`, ≤ 50 plans per pass) indexes plans whose `updated_at` is newer: the text is
  the title, goal, phase titles and item titles / details (`planSearchText`; never decisions, notes or links), redacted,
  chunked, a chunk that still looks secret skipped; only while the owner indexes their conversations; a superseded plan
  loses its vectors. Search scores plan chunks with the messages (best chunk per plan) and returns a hit
  `{messageId: "plan:<id>", plan: {id, title}}`; the keyword fallback matches the plan's title, goal and item titles /
  details (every term). Turning indexing off deletes the plan vectors with the messages'; a model change and a
  conversation hand-over drop them too (re-indexed by the pass for the right owner). The console marks such a hit
  **Plan · <title>**.
- **"Plan incelemeni bekliyor"** — `chat.plan` notification kind `ready` when `plan_create` writes a plan (once per plan,
  dedupe `chat.plan:<plan>:ready:v1`; a replacing plan is a new plan), to the owner through the notification path
  (preferences apply).

## 5. Job composer: "Projeler" → a batch

`web/screens/composer/batch.tsx`: **Başka projelerde de çalıştır** (projects the user works in, never the page's own) in
the Ne section of a job that starts now. Picking projects turns the submit button into **Toplu işi gönder (n proje)**
(also Ctrl/Cmd+Enter): `POST /jobs/batches` with the page's project first, the prompt, its first line as the title, the
runtime and — when set — model, sandbox profile, approval policy and maximum duration (else each project's defaults); the
page's base branch only for its own project (`perProject`). **Kontrol et** shows the W5 preflight (ready / waits /
refused with the reason, the same rows as `/jobs/batches/new`). What a batch cannot carry is named on the page (input
files and zip, deploy / verify / preview when done, schedule, machine and tool requirements, fallback runtimes). With a
schedule picked the other projects are not used (a note says so).

## 6. IDE W1 leftovers (p19-ide "Not in W1")

- **Open PRs / MRs in the Kod tab**: `GitProvider.openPullRequests(limit)` (GitHub `GET pulls?state=open`, GitLab
  `merge_requests?state=opened`, Bitbucket `pullrequests?state=OPEN`; fields from Context7, UNVERIFIED-LIVE),
  `GET /projects/:id/code/pulls` (`code.read`, ≤ 30, cached 60 s): number, redacted title, https link, author, draft,
  base / head branch, fork, and the refs of its compare view (the head commit when the provider gives a full sha — a
  fork's head is in the base repository as `refs/pull/<n>/head` —, else the head branch of the same repository, else
  none). The Kod tab's **Açık PR'lar** (folded; read when opened) links each to `/projects/:id/code/compare`.
- **"Değişiklik iste" keeps the target branch**: the follow-up job starts at the reviewed head (a commit) and its spec
  carries `repository.targetBranch` = the original job's target (`job_git.target_branch`); `GitFlowService.targetBranch`
  takes an explicit target branch first (additive, master-only field of the wire spec; workers ignore it).
- **Line numbers stay right**: the code service masks a multi-line secret line by line (`redactKeepingLines`: each line
  of the secret becomes the marker), so the viewer, the reviewer's hunks, comments and code references keep their lines.
- **Comments on compare views — done in p18-last-gaps** ([design §2](p18-last-gaps.md#2-comments-on-compare-views)); in
  this wave it was not done: comments are anchored to a job (`code_review_comments.job_id NOT NULL`, the
  "outdated" rule and "Değişiklik iste" are a job's); a compare has no agent to send them to. It needs its own anchoring
  (project + base / head), routes and reviewer mode — not small.

## 7. Engine-1 workflow gates in the chat — re-checked, still not done

> **Done in p18-last-gaps** ([design §1](p18-last-gaps.md#1-engine-1-workflow-gates-in-the-chat)): its own card
> variant, claim keys and decide path, as listed below. The text below is the state of this wave.

`v2ForV1` is off by default, so v1 documents do run on engine 1 and their gates are real. But an engine-1 gate is a
`workflow_nodes` row in `awaiting_approval` with `gate_role` only: no node-run id, no wait start, no approval texts or
expiry; the chat's approval card, "Senden bekleyen", the flow claims (`decided:<node run>`), the pushed `flow` event and
the decide route the card calls are all keyed by engine-2 node runs. Announcing engine-1 gates means a second card
variant, its own claim keys and decide path (`POST /workflows/runs/:id/nodes/:node/…` of engine 1) and its web side —
more than this wave. Turning `v2ForV1` on (Ayarlar → Sunucu ayarları) runs v1 documents on engine 2, where the chat
already shows the gates.

## Security

No new authority. The group actions are N single actions under their own project's rules (no aggregated grant; hidden
siblings are counted, never named). Budget cards keep the console's role, input checks, version check, step-up event and
audit, and a loosening change never runs without a person's explicit request. Plan vectors are the owner's only (the
search joins the conversation's current owner), redacted, dropped when indexing is turned off. The PR list is read-only
provider text rendered as text; links only `https:`. The follow-up's target branch comes from the master's own
`job_git` row.

## Tests

- Master unit: `test/unit/p18-leftovers-groups.test.ts` (inputOfDetail, add projects with refusals, pause / resume /
  delete, the resume step-up), `test/unit/p18-leftovers-budgets.test.ts` (loosening rules, planning, confirming through
  the store with the step-up, the direct path's card default), `test/unit/p18-leftovers-misc.test.ts` (plan notice and
  text, line-keeping redaction, the follow-up's target branch, the PR list mapping and cache).
- Master integration (needs a database): `test/integration/p18-leftovers.test.ts`; `test/integration/chat-plan-w4.test.ts`
  now leaves the new `ready` notification out of its decision count.
- Protocol `test/assistant-budgets.test.ts`; agent adapters `test/assistant-budgets.test.ts` (rule 55, rule 54 sentence).
- Web `test/p18-leftovers.test.tsx`; `test/p18-multi-project-w4.test.tsx` mounts the group panel inside the step-up
  provider.
