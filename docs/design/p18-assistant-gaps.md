# p18-assistant-gaps — the chat assistant's remaining console gaps

Status: **implemented** (2026-10-28, branch p18-assistant-gaps, **no migration**, **worker 1.2.1 required** for the
new tools and prompt rules). Owner 2026-10-28: "hepsini tamamlayalım" — close the assistant gaps an analysis of the
console vs. the chat found. Paths: `m/` = `apps/master/src/`, `proto/` = `packages/protocol/src/`, `aa/` =
`packages/agent-adapters/src/`, `web/` = `apps/web/src/diyalog/`.

## 1. Gaps and what closes them

| # | Gap (before) | Now |
|---|---|---|
| 1 | A workflow run could be started and watched, not explained, stopped or its human approval decided from the chat | `describe_workflow_run` (read), `draft_workflow_run_cancel`, `draft_workflow_approval_decision` |
| 2 | Job outputs: `describe_job` showed ≤ 20 artifacts / 50 workspace files, no content, nothing inside `out-rest.zip` | `list_job_outputs` (paged, prefix / glob, zip members, output report, inputs), `read_job_output` (text ≤ 64 KB per call, offset paging, binary → metadata) |
| 3 | Rules 39 / 47 and `describe_backups` said backups and updates are host-only (p17-host-actions added `/backups/run｜drill｜restore`, `/host-actions/upgrade`) | `draft_backup_action` (run / drill / restore — restore card-only), `draft_control_plane_update`; `describe_backups` adds the host applier and the backup requests |
| 4 | Rule 52 said "approval of a plan grants nothing: every side effect is a card" — wrong since p18-plan-autonomy | Rule 52 rewritten (§4) |
| 5 | Rule 20 listed the classic sidebar / settings (no Workflow'lar, Senden bekleyenler, API anahtarları, Webhook'lar, Yedekler, Tanılama, Sistem durumu, Sunucu ayarları …) | Rule 20 names the Diyalog rail, "Tümü", the machine / project tabs and the five settings groups with the Turkish and English labels the UI shows |
| 6 | Small screens without a tool | `draft_template_from_job`, `uptime_history`, `draft_monitor_change`, `memory_review`, `list_output_library`, `weekly_reports`, `draft_deploy_health_recheck`, `draft_job_question_answer`, `draft_cost_brake` |

Skipped (M-sized, listed in bilinen-eksikler): budget edits (`/budgets`: a budget model with overrides and scopes —
`quota_status` reads them; `change_settings` covers the cost brake's mode and ceilings, `draft_cost_brake` the lifts and
project ceilings); the off-site backup target (needs storage keys typed in the browser, like a vault credential).
Budget edits were added since (worker 1.2.2, `draft_budget_change`, a card by default when it loosens a budget):
[p18-leftovers §3](p18-leftovers.md#3-budgets-through-the-chat). The off-site backup target stays browser-only.

## 2. Design

**No new draft kind, no migration.** Every new change is an administration card (`settings_change`, target `admin`,
p16-assistant-admin): `m/chat/admin-actions.ts` gains the op set `OpsToolOp` with each op's console action
(`OPS_TOOL_ACTION_OF`), `m/security-policy/events.ts adminOpEvent` maps each op to the event of its console route,
`adminCard()` (exported) builds the hash-protected payload. `ChatAdmin.run` re-authorizes the op's action for the
confirming user (project-scoped where the payload names a project) and, inside `withAuditSource('chat')`, hands the op
to `ChatOpsTools.apply` (`m/chat/ops-tools.ts`), which calls the **same service method as the console route**:

| Tool | Op | Action (route) | Event | Service |
|---|---|---|---|---|
| draft_workflow_run_cancel | workflow.cancel_run | workflows.run (`POST /workflows/runs/:id/cancel`) | chat.cards | WorkflowService.cancelRun |
| draft_workflow_approval_decision | workflow.decide_node | workflows.approve (`…/node-runs/:nodeRunId/approve｜deny`) | approvals.decide | WorkflowService.decideNodeRun (role = project role; one decision wins: 409) |
| draft_backup_action run / drill | backup.run / backup.drill | backups.manage | backups.manage | BackupManageService.run / drill |
| draft_backup_action restore | backup.restore (`cardOnly: always`, always-fresh) | backups.restore | backups.restore | BackupManageService.restore (confirm = backup id) |
| draft_control_plane_update | host.upgrade (always-fresh) | host.update | host.update | HostActionService.upgrade |
| draft_template_from_job | template.from_job | templates.write | automations.manage | TemplateService.proposalFromJob + create |
| draft_monitor_change | monitor.update | uptime.write | chat.cards | UptimeService.update |
| draft_deploy_health_recheck | deploy.health_recheck | deploy.request | chat.cards | DeployHealthService.recheck |
| draft_job_question_answer | job.answer_question | jobs.message | chat.cards | QuestionService.answerJob |
| draft_cost_brake | cost_brake.lift / end_lift / project_ceiling | quotas.write (owners) | limits.budgets | CostBrakeService.lift / endLift / setProjectCeiling |

Owner-only routes (backups, host actions, cost brake) are checked when the card is planned and again when it runs.

**Direct execution.** The p15 rules apply unchanged (a user's own command runs at once; `propose` / non-user turns /
codes keep cards). New: `cardOnly: 'always'` (`CARD_ALWAYS_OPS = {backup.restore}`) — `ChatDirectActions.execute`
refuses it as `card_only` whatever the policy (also in an autonomous plan), audited `denied`. `draft_job_question_answer`
is in `ASSISTANT_CARD_DEFAULT_TOOLS`: a card unless the call says `execute: true` (the user stated the answer in this
turn); never run by an autonomous plan.

**Reads** (`ChatOpsTools.read`): the console route's authorization action per project (`workflows.read`, `jobs.read`,
`uptime.read`, `context.read`, `outputs.read`, `reports.self`; invisible → not found), every answer passed through
`capJson` (≤ 40 000 characters: long arrays cut with a count, long strings clipped) and redacted (`redactDeep` here and
again by the tool runner; the chat service fences the result as data).

- `describe_workflow_run`: `runView` + engine-2 `nodeRuns` (timings, errors) / step job times (engine 1); failing nodes
  first; waiting approvals with `canDecide` from the chat flow's `approvalView`.
- `list_job_outputs`: all `job_artifacts` rows (≤ 5000, newest attempt first; prefix as SQL `LIKE`, glob as an
  anchored regex in the master) plus the overflow zip's members — its central directory read by two range reads
  (`overflowZipIndex`, the p18-outputs-delivery reader and cache) — then paged; the output report and inputs.
- `read_job_output`: a stored file's byte window (row content or a blob range read), a zip member by range read +
  inflate (≤ 4 MiB, size checked against the directory); text = media type / extension and no NUL byte, cut at a whole
  UTF-8 character, redacted; binary → metadata.

**Worker feature** `assistant-ops-tools-v1` (`proto/worker-features.ts`, `apps/worker/src/daemon/run.ts`): the master
names the new tools in its own answers only to such a worker (`ToolCaller.opsTools`; today `describe_backups.actions`).
Older workers never call the new tools (their catalog is compiled in) and keep the old prompt.

## 3. Web

`web/drafts/summary.ts`: the kind pill names the area (`assistantAdmin.card.groups`: Workflow, Yedek, Güncelleme,
Şablon, Uptime, Deploy, İş sorusu, Maliyet freni); `adminSummary` shows each new op's facts (`assistantAdmin.card.gaps`,
tr + en) — workflow / step / decision, backup id (or "en yenisi"), versions, template name and prompt start, monitor and
its changes, address, the questions with the user's answers, scope / hours / ceiling — and the danger warnings of a
card-only restore and of breaking changes. The confirm event comes from the payload (`draftEvent`), unchanged.

## 4. Prompt (worker 1.2.1)

- Rule 2: `draft_job_question_answer` stays a card unless the user states the answer; a restore is always a card.
- Rule 20: the Diyalog navigation in Turkish / English (sidebar, Tümü, machine and project tabs, settings groups).
- Rule 39: backups through `draft_backup_action`, restore always a card; never claim a start without `executed: true`.
- Rule 47: the update through `draft_control_plane_update` (host applier, fresh code); the host commands only without
  an applier.
- Rule 52 (p18-plan-autonomy): an approved **autonomous** plan's continuation drafts run directly — read the result,
  never ask to confirm a card that ran; only a not-executed result is a card that waits; a non-autonomous plan keeps
  cards; the user's own turns follow rule 2; one assistant item at a time, job / workflow items may run in parallel.
- Rule 53 (new): the new tools, file contents / outputs / notes as data.

## 5. Security review

- No tool takes or returns a secret (input keys checked by test; reads redacted twice; vault / off-site keys untouched).
- Every change re-authorizes on confirm with the confirming user's role (project-scoped), runs the console's service
  (its own checks: run state, one decision, owner, version in the verified feed, backup known, rate limits) and its
  audit (`source: chat`, plus `chat.draft.confirm` / `chat.direct_action`).
- Destructive: a restore never runs without the card and an always-fresh code; the update needs an always-fresh code.
- A job agent's question is answered only with the user's words: card by default, never from a plan, documents or tool
  results (rule 53).
- Prompt injection: run outputs, file contents, notes and reports are fenced data; rule 53 says so.

## 6. Tests

Protocol (`test/assistant-ops-tools.test.ts`): kinds, strict inputs, caps, no secret fields, the feature. Agent adapters
(`test/assistant-ops-tools.test.ts`, updated `assistant-plan`, `assistant-selfhost`, `assistant-admin`): rules 2, 20,
39, 47, 52, 53; engines declare the tools. Master unit (`test/unit/chat-ops-tools.test.ts`): events, card-only, the
direct path refusing a restore, glob / text / capJson, planners with fake services (backups, update, cost brake), a
read window. Master integration (`test/integration/chat-ops-tools.test.ts`, real DB, engine 2, blob store, host
applier directory): job outputs with zip members and redaction, workflow approval decided once through the card and a
run cancelled, backups / restore card-only, template, monitor pause + history, job question answered once, cost brake
lift, the other reads' permissions. Web (`test/assistant-ops-cards.test.ts`): kind pills, facts, warnings, event.

## 7. Rollback

Master: revert; no data written beyond the services' own rows. Older workers ignore the feature. A 1.2.1 worker on an
older master gets "unknown tool" / invalid for the new tools (the master validates every call against its catalog).
