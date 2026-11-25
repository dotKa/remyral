# Design note: `p16-workflow-quality` — no junk cards, project defaults, time zones, triggers that run, optional repository, a competent workflow assistant

- **Task:** `p16-workflow-quality`. **Date:** 2026-10-23. **Migration:** `0140_workflow_quality.sql` (additive).
- **Owner evidence (Sohbet, Turkish):** an hourly WhatsApp reminder workflow produced four cards — "rejected: default
  settings missing", "rejected: sandbox not chosen", "rejected: time zone Europe/Istanbul not supported", then the saved
  one (another request produced ten). The assistant then said the hourly trigger inside the workflow never starts it
  ("a separate automation is needed") and that the AI step could not run without a code repository, and replaced the
  AI step with a fixed list. Running the workflow by hand asked for "Depo adresi / Temel dal" although no step needs
  code.
- **Root causes (from the code):** every `draft_workflow` call stored a card, invalid ones included (`valid: false`);
  `defaults` (runtime, sandboxProfile, limits) was mandatory in the schema and nothing filled it for chat drafts (the
  job composer / `draft_automation` defaults were never applied to workflows); `trigger.schedule` refused any zone but
  UTC (`timezone_not_supported`) and the protocol's `draft_automation` cron input refused a `timeZone` key; trigger nodes
  only start runs after "Etkinleştir" (activation binds them to automations) and a chat-saved workflow was never
  activated; `WorkflowService.startRun` required a repository for every AI step and never fell back to the project's
  registered repository.
- **Builds on:** p13-workflows-ui (draft cards), p14-workflow-engine 14.2 (trigger nodes ↔ bound automations, K2),
  p15-workflow-ai (repair turn), p6-automation-defaults / p6-chat-job-defaults (`ProjectDefaults`), p5-research-workspace
  (scratch directories), p6-quota-scheduling (`zoned-time.ts`).
- **No new ADR:** no new trust boundary. Activation from a card applies exactly the activation policy of
  `PUT /workflows/:id/activation` (webhook / GitHub: project admin + fresh step-up); a scratch step of a repository
  project gets less than a repository job (no checkout, no push).
- **Worker release: yes** — the new tools (`validate_workflow`, `workflow_guide`), the changed tool inputs
  (`draft_workflow.activate/dryRun`, `draft_automation` trigger `timeZone`), rule 38, and the runner accepting
  `JobSpec.workspace.scratch` for repository projects (feature `repo-scratch-v1`). Master first: older workers keep
  working (old tools; scratch steps are never placed on them — placement reason `workspace_unsupported`).

## 1. No junk cards

**Decision: store invalid attempts hidden.** A draft the master's validation refuses is inserted with the new state
`invalid` (migration 0140 widens `chat_drafts_state_check`). Such a row is never listed (`ChatStore.drafts` filters it;
the assets listing and the template source list too), never confirmable (`draft_not_open`, like any non-proposed
draft) and never published on the stream. Why not "don't persist": the p15-workflow-ai repair loop reads the last
`draft_workflow` attempt of a turn by its id, the audit keeps the attempt, and the give-up line needs the attempts of a
turn.

- **One path for every draft kind.** `ChatTools.run` maps each draft-making tool to its card kind (`TOOL_DRAFT_KIND`):
  any `invalid` outcome — an input-schema failure or the tool's own refusal — is stored hidden under that kind unless
  the tool already stored one with structured issues (`draft_workflow`). `forbidden` / `not_found` / `unavailable` are
  not validation problems and store nothing. The tool message still carries `meta.draftId` (the hidden draft), the
  model still gets `{error: 'invalid', message}` with the issues.
- **Give-up line.** When a turn ends `done` and no repair turn was sent, the chat service reads the turn's drafts in
  order (`ChatStore.turnDrafts`, created_at then the tool message's `seq`) and, per kind whose LAST attempt was refused
  with no valid card after it, adds ONE `error` row with `meta.notice = 'draft-invalid'`, `meta.drafts =
  [{kind, attempts, issues}]` (issues as `path: code`, at most five). The console renders it in the reader's language
  ("Taslak geçersiz (Workflow taslağı, 2 deneme): nodes.0.type: invalid_value"). A turn that was repaired shows no line;
  the repair turn that fails again shows one.
- **Validate first.** `validate_workflow` (a read tool) and `draft_workflow {dryRun: true}` run every check of
  `draft_workflow` — defaults, catalog, expressions, addresses, step job specs, schedules, trigger semantics — and store
  nothing. Issues carry a `hint` from the workflow guide (§6).

## 2. Defaults

`applyWorkflowDefaults` (composer/defaults.ts) fills what a drafted document's `defaults` leaves out through the job
composer's own `applyJobDefaults` and `ProjectDefaults.facts` (placement preview): source trust `trusted` when the run
works on the project's own repository (no `defaults.repository`, or the registered one) or none at all; the best ready
host profile where the project allows host execution, else `container`; the security policy's approval default; 60
minutes capped by the project's job limits plus its cost / token / turn limits; the routing rule's runtime for
`execute`, else the first runtime a machine can take, else `claude-code` (the schema needs one; a workflow without AI
steps never starts it). Explicit values are kept. The card and the tool answer list `projectDefaults`. Where it was
skipped: `#draftWorkflow` validated the raw document; the job and automation drafts already used `ProjectDefaults`.
`draft_workflow_run` runs a saved definition (its defaults are fixed); it now reports where the run's code comes from
(§5) and refuses (hidden) a run whose code steps have no repository.

## 3. Time zones

- **Schedules take an IANA zone.** Automation `cron` and `at` triggers accept `timeZone` (validated with `Intl` —
  `isValidTimeZone`); `at` also accepts a local time without an offset (read in the zone). `trigger.schedule` accepts
  `timezone` (existing key) or its alias `timeZone`, validated the same way (`unknown_timezone`, `timezone_twice`); the
  `timezone_not_supported` refusal is gone. Activation passes the zone to the bound automation.
- **Default:** the user's zone when known — the zone the chat message carried (the browser's, `meta.timeZone`), else
  the user's weekly-report zone (`user_report_settings.time_zone`) — else UTC. Applied when drafting (chat) and as the
  automation form's default; the REST API's default stays UTC (backward compatible).
- **DST-correct next runs** in the in-house cron (no dependency added; `security:pins` unchanged): `parseCron(source,
  zone)` reads the fields on the zone's wall clock using `zonedParts` / `zonedToUtc`. Rules (as cronie): a fixed-hour
  schedule runs **once** for a wall time that is skipped (spring forward: at the first minute after the gap) or repeated
  (fall back: the first occurrence); a schedule whose hour field is `*` keeps its real-time cadence. UTC keeps the old
  fast path. Catch-up planning, previews and summaries use the zone ("Every day at 09:00 Europe/Istanbul").
- **Storage:** `automations.time_zone text NOT NULL DEFAULT 'UTC'` (every existing row UTC — nothing scheduled moves);
  the trigger JSON keeps `timeZone` when not UTC. The view and `GET /automations/cron-preview?timeZone=` return it.
- **Console:** schedules read in words with their zone ("her saat başı · Europe/Istanbul") in the list, the detail and
  the draft cards; the form has a zone field (datalist of the runtime's zones, default the browser's).

## 4. Trigger nodes start runs

**Decision: keep automations the single trigger runtime (K2) and make activation automatic where the user asked.**
One scheduler for all replicas already exists: `AutomationService.fireDue` claims due rows `FOR UPDATE SKIP LOCKED`
and every enqueue carries a dedup key (`cron:<instant>`), so two masters fire a schedule once (tested with two app
instances on one database).

- A `draft_workflow` card **activates** its bound triggers (schedule / webhook / GitHub / workflow) on confirmation —
  `activate` defaults to true when the document has such triggers. Webhook / GitHub activation needs
  `automations.external` and a fresh step-up: the card lists `automations.external` as privileged (event
  `workflows.privileged`) and the confirmation checks both **before** saving (a refusal saves nothing). A webhook secret
  created now is revealed once in the confirmation answer (never stored on the draft).
- **Every save** (`POST /workflows`, `PUT /workflows/:id`, chat card) runs `WorkflowTriggerService.afterSave`: triggers
  that follow the latest version (an enabled, unpinned binding) are re-synced at once (new crons / zones apply, removed
  nodes pause); otherwise the answer says plainly that they do not start runs yet (`triggers.state` `inactive` /
  `not_synced` / `pinned` with a warning). A failed re-sync is reported, never thrown (the version is saved).
- **Archive** pauses the bound automations (an archived workflow refuses runs; a live schedule would only fail).
- **Catalog / tools:** `workflow_node_catalog` gives each type `runnable`, and trigger types `startsRuns` and
  `needsActivation`; `trigger.manual` (by hand), `trigger.chat` (a run card), `trigger.error` (settings.onFailure) need
  no activation. Every trigger type is runnable — none is saved dead.

## 5. Repository not mandatory

- **Fallback order:** run input → workflow `defaults.repository` → the project's registered repository
  (`project_git_configs`). Workspace projects are unchanged.
- **None at all:** AI steps run without a checkout in a scratch directory: the engines create the step job with
  `scratch: true`; `JobStore.create` fills `spec.workspace = {egress: 'web', scratch: true}` for a repository project
  (egress `web` because repository jobs reach the network too). Only steps that work on code need a repository:
  `needsRepository: true` (new optional AI-step field, last key — existing definition hashes unchanged), integrators
  and Coolify deploy steps; such a run is refused with `400 repository_required` naming the steps.
- **Worker change (needed):** the worker accepted a workspace spec only for its workspace projects. A scratch step of
  one of its repository projects (`repositoryProjects` from the applied config) now runs with the egress ceiling `web`;
  any other workspace spec of a non-workspace project is still refused. Feature `repo-scratch-v1`; placement requires it
  (`workspace_unsupported` with a "repo-scratch-v1" message otherwise).
- **Console:** the run form's repository fields are optional ("Depo adresi (isteğe bağlı)", "Temel branch (isteğe
  bağlı)"), the placeholder is the workflow's or the project's repository, the hint says what happens when empty; the
  run card says "Depo: projenin deposu / Depo yok: adımlar kodsuz, geçici bir klasörde çalışır".

## 6. Assistant competence

- `workflow_guide` (read tool, `topic` all / triggers / patterns / errors / repository): rules, trigger semantics,
  minimal valid documents (scheduled HTTP message with schedule + manual merged by `control.merge {join: any}`, AI step →
  HTTP, approval gate, forEach), common errors with fixes. Every pattern is validated in the integration suite.
- `draft_workflow` description: one valid draft, validate first, leave defaults out, IANA timezone, triggers active
  only after the card, no repository needed for AI steps, `needsRepository`, `activate`, `dryRun`.
- **Rule 38** (agent-adapters system prompt): build workflows in one valid draft; validate first; never leave an
  invalid card; stop after two failed validations and explain; defaults out; zones; triggers need activation;
  never replace an AI step with a fixed list because of a repository problem. Rule 11 no longer says "cron in UTC".

## 7. Security

- Hidden drafts keep the same payload rules as cards (paths and codes only for workflow issues; prompts stay in the
  definition as before); they are only readable by their owner (by id) and never confirmable.
- Activation from a card is the activation route's policy (role, external triggers, fresh step-up, audit
  `workflow.activate`); the run-as user of a bound automation is the confirming user, as on the canvas.
- Scratch steps: no checkout, no push, no secrets beyond the job's own; egress capped at `web` like the repository jobs
  of the same project; placement only on workers that have the project as a repository project.
- The browser's zone is validated (`isValidTimeZone`) before it is stored in message meta.

## 8. Tests

- master unit: cron zones incl. both DST boundaries (`schedule-cron-zones`), workflow defaults + hints
  (`workflow-defaults`).
- master integration (`workflow-quality`): hidden invalid drafts for every kind path, confirm refused; defaults and the
  user's zone on drafted workflows / automations; the scheduler on a zone's wall clock across a DST change;
  `validate_workflow` (every guide pattern valid) and `workflow_guide`; a schedule activated by the card fires **once**
  across two master replicas and starts a run; REST re-sync on a new version; archive pauses; a never-activated save
  warns; webhook activation (admin + fresh code, secret shown once, a signed call starts a run); repository fallback
  chain, repo-less AI step (scratch spec), integrator / needsRepository refused, run card repository source.
  `workflow-ai`: repair turn on a hidden draft, give-up lines (none after a repair, one after two invalid attempts, none
  after invalid → valid).
- worker: scratch step of a repository project runs; other workspace specs refused. scheduler: placement needs
  `repo-scratch-v1`. protocol / agent-adapters: tool schemas, rule 38.
- web: zone wording (TR / EN), the form's zone in the trigger, draft card wording, give-up line, trigger note, run form
  optional repository fields (labels, placeholders), the list's zoned schedule.

## 9. Rollback

Master rollback: the old master ignores `automations.time_zone` (zoned schedules then run in UTC) and would list hidden
drafts as unknown-state cards — delete them first (`DELETE FROM chat_drafts WHERE state = 'invalid'`). Worker rollback:
scratch steps are no longer placed on it (feature gone). The migration's header has the SQL.

## 10. Unverified

- A real model following rule 38 / the guide (the fake engine plays scripted turns).
- A real worker running a scratch step end to end with a real runtime (unit-tested with the fake adapter); Windows /
  Linux sandboxes for scratch steps of repository projects.
- DST behaviour against zones with 30-minute shifts (Lord Howe) beyond the tz database's own rules.
