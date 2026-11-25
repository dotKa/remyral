# p15-merge-approvals — merge decisions that open themselves, agent git note, short watch labels, low disk

Status: implemented (2026-10-22). Backlog: `p15-merge-approvals`. Migration 0124. Owner-blocking batch.

## 1. Merge decisions never opened (bug, prod 2026-10-22)

### 1.1 Symptom and root cause

Git-flow jobs in `demo-app` went VERIFYING → AWAITING_APPROVAL (`verification_passed`, "git flow: verified
rac/<job>/<attempt>@<sha> … merge check: unknown") and **no `approval_requests` row existed**. For one of these jobs the
gate row appeared only when the owner pressed a button on the job page (created and approved in the same minute,
merge request `left_open`). Nothing showed in Senden bekleyenler or notifications, the chat assistant found nothing to
approve, and jobs sat in AWAITING_APPROVAL until cancelled.

Root cause (reproduced first by `gitflow.test.ts` "verification opens the merge approval in the same transition",
which failed with no pending approval): `GitFlowService.#finishVerification` (apps/master/src/gitflow/service.ts)
applied `verification_passed` and stopped there. The only code that created the `git.merge` gate approval and its
`git_merge_requests` row was `GitFlowService.request()`, called by `POST /jobs/:id/merge` (the job page's "Request
merge" / "Accept without merging") and by the workflow merge gateway. The design (p4-git-flow §6) had made the request
an explicit human action; nothing announced that a decision was waiting.

A second latent issue: for an `allow-all` job under Serbest / Dengeli, `git.merge` resolves to `allow` (p15-autonomy
autonomy layer) and `request()` refused it ("resolved to allow without approval") — the owner's policy said "let it
pass" and the code said "impossible".

### 1.2 The decision opens with the transition

`#finishVerification` now calls `#openDecisionIn(tx, jobId)` **inside the transition transaction**, under a savepoint:
a failure rolls back only the decision (logged); the verified result still commits and the loop opens it later.

`#openDecisionIn` (idempotent; job row locked):
- skips when the job is not AWAITING_APPROVAL, not verified, already merged, has no file changes, or has an open merge
  request (`pending | approved | executing`) or a pending gate approval;
- **mode**: `merge`, unless the merge check says `conflicts` / `base_moved` or a merge of this head was already
  refused — then `leave_open` (approve = accept and keep the PR open, deny = reject);
- `ApprovalService.evaluateWithin(tx, {action: 'git.merge', approvalKey: '<mode>.<n>', requestedBy: system gitflow})`
  (new: `evaluate` inside the caller's transaction). The approval policy decides as everywhere (platform floor →
  project rules → job mode → the owner's security policy):
  - `require_approval` → pending gate request + `git_merge_requests` row with `requested_by` NULL ("opened by the
    platform"); `evaluate` writes the `approval.requested` outbox row → notification; Senden bekleyenler, the job
    page's approval card, the needs-you card and chat (`suggest_approval_decision`, `execute: true`) decide it through
    `ApprovalService.decide` → the existing gate hook (merge executes after commit, sha guard, CI rule);
  - `allow` (only the security-policy autonomy layer can resolve `git.merge` to allow, for an `allow-all` job) → a
    merge request `approved` with `approved_via = 'security_policy'`, no approval row, executed after commit. The job
    moves with the new trigger `approval_auto_granted` (AWAITING_APPROVAL → SUCCEEDED, **system** actor, reason
    required). `leave_open` decisions, workflow steps and sub-jobs (`job_subtasks`, `workflow_nodes`,
    `workflow_node_run_jobs`) never take the autonomy path (`ignoreAutonomy`: a person decides);
  - `deny` (e.g. a `deny-sensitive` job) → nothing opens; logged; the job waits for a person to cancel it.
- members of a master-managed integration (`ownPullRequest` false) get no decision of their own (the integration's
  merge approves them, p11-merge-pipeline).

### 1.3 Supersede, re-open, backfill

- **A person's choice wins**: `request()` with another mode while the master's own request is pending withdraws it
  (`ApprovalService.withdrawGate`, audited `approval.cancel` with `why`; merge request `cancelled`) and opens the
  person's request **in one transaction** — if the new one is refused (policy deny), the master's stays open. A
  person's request skips the autonomy layer (a person asked, a person decides; this also removes the old
  "resolved to allow" refusal).
- **Conflicts after the fact**: a refresh that finds `conflicts` / `base_moved` withdraws the master's pending merge
  request; the loop opens the leave-open decision.
- **Loop step `decide`** (every git-flow tick; also the backfill): jobs in AWAITING_APPROVAL, verified, not merged,
  without an open merge request, whose `job_git.decision_closed_seen` is NULL (never looked at — every job stuck before
  this fix) or lower than the number of closed merge requests (a request closed since: refused or withdrawn). Deterministic (counts, not clocks), so it never re-opens the same state twice.
- **Execution**: a released request (merge check still unknown, CI running) waits one refresh interval before the next
  try (`claimed_at` back-off); a policy merge waits for running CI within the project's CI timeout instead of being
  refused.

### 1.4 UI

- Changes card (Diyalog): when the open request is the platform's pending merge, "Birleştirmeden kabul et"
  stays available — it supersedes the merge request. Merge requests without an approval row (policy) render without a
  link. API: `approvalRequestId` and `requestedBy` nullable, `approvedVia` added.

## 2. Agents and git under git flow

Under the sandbox the agent cannot write `.git` ("cannot lock ref 'HEAD'"); the worker commits and pushes the attempt
branch itself. Repository jobs with `execution.pushResult` (git flow, not a pinned PR head) now get the preamble
(apps/worker/src/jobs/gitflow-note.ts, shared by all four runtimes — the prompt is assembled in the runner):
"Do not run git commit/push; leave your changes in the working tree — the platform commits and pushes them after the
run." plus that a read-only `.git` is expected. The JOB_RESULT summary gains one line naming the `branch@sha` the
platform pushed; when the agent's text reports a failed commit/push (EN/TR patterns) the line says that is by design.
The chat assistant reads the same summary.

## 3. Short watch labels

Job watches were labelled with the prompt's whole first line. `#resolve` builds `İş <8> · <short title>` /
`Job <8> · <short title>` (`@remyral/i18n` `watches.jobLabel`) in the watch's language: the job's own title (a
sub-job's `job_subtasks.title`) else the first 6 words of the prompt's first non-empty line, at most 40 characters cut
at a word (`shortJobTitle`). The Diyalog watch strip cuts any label (older rows) at 48 characters; the full label stays
in the tooltip.

## 4. Low disk is a placement reason, not a job failure

`DiskQuotaError` failed jobs one after another on win-1 (minimum 20 GiB, 19.3 GB free).
- Worker: HEARTBEAT `load.workspaceDisk {freeBytes, minFreeBytes}` (additive, optional) — statfs of the workspace root
  and the effective `workspace.minFreeBytes` read on every sample (panel changes apply). Lease admission runs the disk
  check first and **declines** (transient, retry after 2 min, `disk_low: …`) instead of failing the job.
- Scheduler: `PlacementWorker.disk`; reason `disk_low` (transient; every job except function jobs) with params
  `freeBytes` / `minFreeBytes`. A job with only that machine waits; otherwise it goes elsewhere.
- Master: `workers.load` already stores the heartbeat; `diskFacts(load)` feeds placement; `/fleet/overview` and
  `/workers` expose `workspaceDisk`.
- Console: reason sentence TR + EN, fix "En az boş disk ayarını aç" → Makine → Yapılandırma; the machine page (Diyalog
  and classic) shows "Çalışma alanı diski: X boş · en az Y isteniyor" and a warning with the link when below.

## 5. Tests

- `apps/master/test/integration/gitflow.test.ts` (real master + real worker daemon, real pushes):
  verification opens the approval in the same transition (single-statement snapshot), Senden bekleyenler list,
  outbox notification row, idempotent job-page request and loop, decision from the approvals API → merged; backfill of
  a job whose decision could not open with the transition (failure injected once), supersede by "accept without
  merging"; Serbest + allow-all job merged by policy (system `approval_auto_granted`, audit `approvedVia`); conflicts
  after another merge → withdrawn merge request + leave-open decision; item 2 preamble in the prompt and the summary
  line. Existing git-flow, merge-pipeline, approvals, workflow-integrations, result-reuse, jobs suites pass.
- Scheduler: transition table (31 triggers, 49 rules, system-only `approval_auto_granted` with reason), `disk_low`.
- Worker: git-flow note unit tests, telemetry `workspaceDisk`, lease decline on low disk.
- Master: `diskFacts`, heartbeat → placement → fleet overview (capacity-auto integration), chat watch label
  (unit + chat-watches integration).
- Web: Changes request parsing with nullable fields, watch strip cut, machine page warning (Diyalog + classic).

## 6. Security review

| Threat | Mitigation |
|---|---|
| Auto-merge without a human approval policy (AGENTS.md rule 10) | Only the owner's security policy can resolve `git.merge` to allow, only for `allow-all` jobs (trusted source + project opt-in, ADR-0020), never for leave-open, workflow steps or sub-jobs; the platform floor stays for everything else. The system transition is a separate trigger (`approval_auto_granted`, reason required), so "a human approved" (`approval_granted`, user only) keeps its meaning. Sha guard, merge check and CI rule unchanged. |
| A pending request opened without a person | It is only a question: deciding still needs the rule's role and step-up. `requested_by` NULL is shown as the platform; audit `git.merge.request` actor `system:gitflow` (`openedBy: gitflow`). |
| Supersede abused to drop a pending decision | Only the master's own pending request is withdrawn, only in the same transaction that opens the person's request; a refused replacement rolls back the withdrawal. Withdrawal audited (`approval.cancel`, `why`). |
| Loop re-opening forever / spamming | Re-open only when a request closed since the last look (counter); deny outcomes are recorded and not retried. |
| Prompt/summary text | The preamble is fixed text; the summary note contains only the platform's own branch and sha (no agent text is trusted for decisions). |
| Disk figures from the worker | Used only to exclude (never to include) a worker; the worker still enforces its own check. |

## 7. Operations

- Migration 0124: `git_merge_requests.requested_by` / `approval_request_id` nullable, `approved_via`
  (`human` default), checks; `job_git.decision_closed_seen`. Rollback: older code reads the rows; only roll back
  before any policy merge row exists (older code's types assume a non-null approval id), or mark them first.
- After deploy, the first git-flow loop pass opens the decisions of every job stuck in AWAITING_APPROVAL (notifications
  are sent for them). Owner: expect one notification per stuck job in `demo-app`.
- Behaviour change: an opened merge decision expires like every gate request (`git.merge` default 7 days, project
  rules may change it) and the job is then cancelled ("approval for git.merge expired") — before, such jobs waited in
  AWAITING_APPROVAL forever. Approval deadlines can be extended (p15-autonomy §10).
- Outbox: the new trigger appears in `job.transition` payloads; deploy master replicas together.
- Worker release needed for items 2 and 4 (until then: no preamble/summary note; no `workspaceDisk`, so no `disk_low`
  — jobs still fail on win-1; lowering its minimum below the free space is the stop-gap).
- UNVERIFIED: the backfill on the real `demo-app` jobs; win-1 reporting `workspaceDisk` (Windows statfs
  on the workspace root) after the worker release.
