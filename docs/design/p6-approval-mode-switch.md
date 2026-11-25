# p6-approval-mode-switch — change a job's approval mode before it starts and while it runs

Status: implemented 2026-10-16 (task `p6-approval-mode-switch`). Migration 0057. **Worker release needed** (new
protocol message `SET_APPROVAL_POLICY`, feature `approval-mode-switch-v1`, live switching in all four adapters).
Related: ADR-0010 (authority order), ADR-0020 (full access / `allow-all`), [p4-approvals.md](p4-approvals.md),
[p6-safe-auto-approve.md](p6-safe-auto-approve.md), [p5-ops-chat.md](p5-ops-chat.md) (JOB_MESSAGE, the model for the
new message).

Owner request (2026-10-16): "approval modunu iş başlamadan önce ve iş esnasında değiştirebilmeliyim" — *I must be
able to change the approval mode before a job starts and while it runs.*

## 1. Problem

`JobSpec.approvalPolicy` (`ask-all` · `ask-sensitive` · `deny-sensitive` · `allow-all`) was fixed when the job was
submitted: the spec is immutable after submission (`jobs_guard_update` trigger), every reader took the mode from
the spec, and the runtime was started once with a mode derived from it (Claude Code permission mode, Codex
`approvalPolicy`, Pi gate extension policy, OpenCode permission ruleset). An owner who started a long job with
"Ask for sensitive actions" and then got ten prompts in a row, or who gave a job "Never ask" and wanted it to ask
again, could only cancel and resubmit. The chat draft card only *showed* the mode; changing it meant "Edit in
composer".

## 2. Decisions

1. **Where the mode lives.** The spec stays immutable. Changes go to an append-only, versioned table
   `job_approval_mode_changes (job_id, seq, from_mode, to_mode, actor, job state / attempt / epoch / worker at the
   time, delivery, application, detail, pending approvals resolved)`. The **effective mode** of a job is the
   `to_mode` of its highest `seq`, else `spec.approvalPolicy`. `JobStore` merges it into `JobRecord.spec`, so every
   master reader (placement, ASSIGN_JOB, machine-admin auto-approve, job detail, chat tools) sees the effective
   mode without knowing about the table; the approval engine and the machine-admin request path, which read raw
   SQL, use the same `effective_approval_policy` expression. The original value stays readable
   (`approvalMode.original`), and every change is on the job timeline.

2. **Who may change it, and under which gates — the same as creating such a job.**
   - New authorization action **`jobs.approval.mode`** (project scope, **operator+**, like `jobs.create` /
     `jobs.cancel`; viewers never). CSRF, audited (`job.approval_mode.change`, success and denied, with
     `from → to`, actor, state, attempt, worker, delivery).
   - `allow-all` needs what submission needs (ADR-0020): `sourceTrust: trusted` and the project's
     `auto_approve_execution` (Projects → Execution policy). Creation needs no step-up, so neither does this.
   - Machine administration jobs (ADR-0021): only `ask-all` ↔ `allow-all`, only for users with
     `machines.admin.run` (owner), and `allow-all` additionally needs an **always-fresh step-up** (like creating
     such a task), the worker's Machine admin → auto-approve and the Machines project's auto-approve.
   - Any non-terminal state except `CANCELLING`: `DRAFT`, `QUEUED` (also waiting for placement / quota / off-peak),
     `RESERVED`, `STARTING`, `RUNNING`, `VERIFYING`, `AWAITING_APPROVAL`, `RETRY_WAIT`, `BLOCKED`, `LOST`.
   - A job whose live attempt runs on a worker **without `approval-mode-switch-v1`** is refused (409
     `worker_update_required`): the master would otherwise show a mode the runtime does not run in.
   - Optimistic concurrency: the request carries `expectedSeq` (the change the user saw; 0 = none) — 409
     `approval_mode_conflict` otherwise. Rate limit: 10 changes per job per minute, 30 per user per 10 minutes.
   - The platform floor is untouched: the job layer still can only tighten (`resolveRule`); `allow-all` changes
     nothing at the master except what the runtime asks. Protected merge, force push, deploy, deletes outside the
     workspace, secrets and elevated commands keep their approvals.

3. **Before the job runs.** The mode is editable wherever a job is prepared — composer (Rules), automation form,
   and now the **chat draft card** (a select on job and machine-task drafts; the confirmation sends
   `approvalPolicy` as an explicit override next to the hash-protected draft payload, re-checked by the normal
   creation path and recorded in the `chat.draft.confirm` audit as `approvalPolicyOverride`) — and on a submitted
   job that has no live attempt yet (job page → Approval mode). Such a change needs nothing on the worker: the next
   ASSIGN_JOB carries the effective mode. **Race with dispatch:** the change takes the dispatcher's advisory lock
   (`remyral:dispatch`) in its transaction, so either the dispatch finished first (then there is a lease and the
   change is sent to the worker as for a running job, after the ASSIGN_JOB in the worker's sequenced outbox) or the
   dispatch reads the new mode.

4. **While it runs — master side.** In the same transaction as the change row:
   - **Pending in-run approval requests are re-evaluated** (gate requests — merge, protected push — are left to the
     human who is already asked):
     - → `deny-sensitive`: every pending in-run request whose rule now resolves to `deny` is closed `denied`
       (decided by the switching user, reason "approval mode changed to deny-sensitive"); the worker gets `deny`.
       *Tightening applies to pending immediately.*
     - → `allow-all`: pending in-run **`runtime.dangerous_tool`** requests are approved (the runtime would not have
       asked under the new mode); audited **`approval.auto_mode`** per request with the change id. Every other
       action keeps waiting (platform floor). *Loosening resolves only what the new mode itself would not ask.*
     - → `ask-sensitive` / `ask-all`: nothing is resolved (requests already with a human stay there; a safe-command
       claim is not stored on the request, so it cannot be re-checked).
   - **Signed control to the worker:** `SET_APPROVAL_POLICY` (sequenced, job-scoped, fenced by attempt + epoch like
     APPROVAL_DECISION / JOB_MESSAGE, written to the worker outbox in the same transaction). Payload: `changeId`,
     per-job `seq`, `approvalPolicy`, `autoApproveOptIn` (project opt-in re-read now), `changedBy`, `issuedAt` and an
     **Ed25519 lease-key signature** over worker, job, attempt, epoch, change id, seq, mode, opt-in and time
     (context `remana-approval-mode/v1`). Sent only to workers that advertise `approval-mode-switch-v1`.

5. **While it runs — worker side.** The runner checks, in order: live attempt + epoch (else dropped), signature
   against its lease keys (pinned `masterLeaseKeys` if configured), `seq` greater than the last applied one (replay
   / reorder protection), and its own gates: `allow-all` only with `autoApproveOptIn` and a trusted source (the same
   `autoApproveRefusal` as at admission), machine-admin only `ask-all` / `allow-all` and `allow-all` only with the
   machine's local Machine admin auto-approve. Then it updates the job's mode and calls the adapter's
   `setApprovalPolicy`; if the runtime has not started yet, the new mode is simply what it starts with. It answers
   **`APPROVAL_POLICY_STATUS`** (control) with `applied` + how (`live` · `gate` · `partial` · `next_turn`) and a
   plain-language detail, or `refused` + why; the master stores it on the change row and the job page shows it.

6. **Per runtime (verified against the pinned versions, nothing guessed):**

   | Runtime (pin) | How a change takes effect | Tightening | Loosening |
   | --- | --- | --- | --- |
   | Claude Code (SDK 0.3.296, `Query.setPermissionMode` in `sdk.d.ts`) | The adapter's `canUseTool` reads the live mode on every call; the CLI's own mode is switched with `setPermissionMode` (`default` / `dontAsk` / back to `bypassPermissions` only when the session started in it) | **live** (also out of `bypassPermissions`) | to `ask-*`/`deny-sensitive`: **live**; to `allow-all` from a non-`allow-all` start: **gate** (the CLI stays in `default` because `disableBypassPermissionsMode: "disable"` is set for such sessions; `canUseTool` allows every call) |
   | Codex (0.162.1 app-server) | `approvalPolicy` exists only on `thread/start`, `thread/resume` and `turn/start` (generated protocol) — there is no live update. The adapter's approval handler reads the live mode. | stricter Codex policy (`never` → `on-request` → `untrusted`) during a running turn: **next_turn** — Codex does not ask during the current turn; the stricter mode starts with the next turn (a follow-up message), before the first turn it is **live** | **gate** — requests Codex still sends are answered by the new mode (`allow-all` approves, `deny-sensitive` denies) |
   | Pi (1.1.0) | The Remyral gate extension asks the adapter for the live mode before every tool call (a `select` dialog with the `remyral-policy:v1:` marker, answered at once by the adapter; no answer / timeout → the call is blocked) | **live** | **live** |
   | OpenCode (1.19.0) | The permission ruleset is fixed at `POST /session`; `PATCH /config` is blocked by the job server guard. Requests that OpenCode asks are answered by the live mode. | **partial** when the old ruleset allowed without asking what the new one would ask or deny (e.g. read-only tools for → `ask-all`, workspace edits under `ask-sensitive` → `deny-sensitive`, everything under `allow-all`); otherwise **gate** | **gate** (asks are auto-answered; keys the old ruleset denied stay denied — never looser than intended) |

   `partial` and `next_turn` are shown as warnings with the reason and the remedy ("cancel and resubmit with the
   new mode if it must apply now"); nothing is claimed that is not enforced.

7. **UI.** Job page header: an **Approval mode** control (current mode, original if changed, a select with the
   four modes, `allow-all` disabled with the reason when not allowed, viewers see it read-only) plus the state of
   the last change: *applies when the job starts* · *waiting for the worker* · *applied live* · *enforced by the
   worker's gate* · *partly applied* (warning) · *applies from the next turn* (warning) · *refused by the worker*
   (danger). The timeline lists every change (`from → to` by whom, and how it was applied). The same control is on
   a confirmed job card in chat. The chat draft card gets a mode select before Confirm.

## 3. Protocol (additive in 1.0)

- Feature `approval-mode-switch-v1` (worker-features.ts).
- `SET_APPROVAL_POLICY` (master → worker, **sequenced**, job message): `{attemptId, epoch, changeId, seq,
  approvalPolicy, autoApproveOptIn, changedBy, issuedAt, signature?}`. Older workers never receive it.
- `APPROVAL_POLICY_STATUS` (worker → master, control, job message): `{attemptId, epoch, changeId, seq, outcome:
  applied | refused, application?: live | gate | partial | next_turn, detail}`.
- `approvalModeStatement` / `signApprovalMode` / `verifyApprovalMode` in `@remyral/protocol` (approval-mode.ts).

## 4. REST

- `GET /jobs/:id/approval-mode` (`jobs.read`, viewer+): current / original mode, seq, whether the caller may change
  it, per mode whether it is allowed (with the reason), the live attempt's worker support, and the change history.
- `POST /jobs/:id/approval-mode` (`jobs.approval.mode`, operator+, CSRF; always-fresh step-up only for a
  machine-admin job going to `allow-all`): `{mode, expectedSeq, reason?}` → `{changed, approvalMode}`. Errors: 409
  `worker_update_required` · `job_not_changeable` · `approval_mode_conflict` · `auto_approve_not_allowed` ·
  `auto_approve_requires_trusted_source` · `approval_mode_unsupported`; 403 `step_up_required`; 429 `rate_limited`.
- `GET /jobs/:id` (detail) shows the effective mode in `spec.approvalPolicy` (JobStore merge); the job page reads the
  history for its timeline from `GET /jobs/:id/approval-mode`.
- `POST /chat/drafts/:id/confirm` accepts an optional body `{approvalPolicy}` (job and machine-task drafts only).

## 5. Storage (migration 0057)

`job_approval_mode_changes`: `id uuid`, `job_id`, `seq` (unique per job, ≥ 1), `from_mode`, `to_mode` (CHECK in
the four modes), `actor_id` (users), `job_state`, `attempt_id`, `epoch`, `worker_id`, `delivery`
(`not_running` · `sent`), `application` (`live` · `gate` · `partial` · `next_turn` · `refused`, null until the worker
answers or when not running), `application_detail`, `applied_at`, `pending_resolved`, `reason`, `created_at`. A
trigger refuses deletes and any update except filling the worker's answer once. Index `(job_id, seq DESC)`.

## 6. Tests

- Protocol: schemas, fixtures, signature round trip / tamper / wrong key / wrong worker.
- Adapters: Claude Code (fake SDK records `setPermissionMode`; `canUseTool` follows the live mode; failure of the
  SDK call → `partial`), Codex (pure transition table + the approval handler with the live mode), Pi (mapper policy
  dialog; the gate source executed with a fake Pi asks for the mode and follows it, blocks without an answer),
  OpenCode (ruleset comparison → `gate` / `partial`; live gate answers).
- Worker: fencing, bad signature, replayed seq, `allow-all` without opt-in / untrusted refused, not-yet-started job,
  adapter result reported in APPROVAL_POLICY_STATUS.
- Master integration: queued change → ASSIGN_JOB carries it; running change → signed outbox message, pending
  approvals denied / approved (`approval.auto_mode`), `worker_update_required`, `allow-all` gates, conflict, viewer
  refused, audit rows, status report stored, detail/timeline; rbac matrix (`jobs.approval.mode`), route coverage.
- Web: job page control (allowed/disabled options, apply, warnings), chat draft card select → confirm override.

## 7. Security review

- **Escalation through the switch.** `allow-all` is reachable only under the gates that let such a job be created
  (operator in the project, trusted source, project opt-in; machine admin: owner, always-fresh step-up, worker +
  Machines project). The master checks, the worker checks again (opt-in in the signed message, trusted source,
  local machine-admin ceiling). Viewers are refused by the central authorizer and the denial is audited.
- **Forged or replayed control messages.** `SET_APPROVAL_POLICY` is only accepted for the live attempt/epoch, with a
  valid lease-key signature binding worker, job, attempt, epoch, change id, seq, mode and opt-in, and a seq above the
  last one applied. A captured message cannot be replayed to another worker, job or attempt, or to roll back a later
  change. The authenticated session (TLS + device key) is the first barrier; the signature is defence in depth like
  OPS_COMMAND.
- **Repository content** still has no authority (ADR-0010): only an authenticated human's request changes the mode;
  nothing the agent writes can (the Pi policy answer comes from the adapter over the RPC pipe, not from a file the
  agent could edit).
- **Honest enforcement.** Where a runtime cannot be tightened mid-turn (Codex) or its ruleset allowed something
  without asking (OpenCode), the worker reports `next_turn` / `partial` and the panel says so; the master never
  shows a stricter mode as fully in force. Pending requests are tightened at once; loosening auto-resolves only
  `runtime.dangerous_tool` requests, audited per request.
- **Auditing.** Every change (success and denial), every auto-resolved approval, and the worker's answer are
  recorded; the change table is append-only (trigger).
- **Availability.** Rate limits per job and user; the worker message is bounded and sequenced (outbox limit).

**Known limits (documented, not hidden).** A refusal by the worker (bad signature, local gate) leaves the master on
the new mode — for a tightening this is the safe side; pending requests already auto-approved by a loosening stay
approved (the master checked the same gates first). Gate requests (merge, protected push) and machine-admin elevated
command requests are never auto-resolved by a switch. A safe-command claim of an already-open request is not
re-checked when switching to `ask-sensitive` (it is not stored).

## 8. Rollout and rollback

Deploy master (migration 0057 is additive), then the worker release. Until a worker advertises the feature, running
jobs on it refuse the switch with "update the worker"; queued jobs work at once. Rollback: older masters ignore the
table (jobs then run with their spec mode — a queued job changed before rollback runs with its original mode);
older workers never receive the message.

## 9. Unverified (needs the owner / real hardware)

- Claude Code `setPermissionMode` against the real pinned CLI mid-run (the SDK typings and the fake are verified;
  the CLI's acceptance of `default` ← `bypassPermissions` on a real session is UNVERIFIED).
- Pi `select` with a non-approve option value through the real 1.1.0 RPC (the same dialog path as approvals is
  verified; the policy dialog itself only against the fake).
- A live switch on the Windows / macOS / Linux fleet machines after the worker release.
