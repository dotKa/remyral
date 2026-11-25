# Design note: approval policy engine (P4)

- **Status:** Implemented
- **Date:** 2026-10-13
- **Backlog:** p4-approvals (acceptance A-ORCH-5: an explicit approval is required for protected merge and
  destructive actions; ROADMAP P4 gate "protected merge requires approval")
- **Decisions applied:** ADR-0009 (step-up for privileged actions), ADR-0010 (authority order, enforcement
  outside the model), ADR-0004 (fencing epochs), ADR-0003 (transactional outbox)
- **Builds on:** [p4-job-store.md](p4-job-store.md) (`AWAITING_APPROVAL`, `approval_granted`/`approval_denied`
  are `user`-only transitions)
- **Threat model:** T-INJ-2 (injected push/merge/deploy), T-INJ-3 (malicious change merged), T-OPS-3
  (repudiation of approvals)

## 1. Scope

| Piece | Where | Responsibility |
| --- | --- | --- |
| Policy model | `apps/master/src/approvals/policy.ts` | Pure: action catalog, platform defaults + floor, project rule schema, write-time floor check, `resolveRule` (platform → project → job; repository ignored). |
| Policy store | `apps/master/src/approvals/policy-store.ts` | `project_policies` (versioned, append-only), owner/admin + step-up for writes, audited. |
| Engine | `apps/master/src/approvals/service.ts` | `ApprovalService.evaluate / decide / sweep / list / get`. |
| Worker contract | `apps/master/src/approvals/outbox.ts` | Outbox topic `approval.decision` + `toApprovalDecisionMessage()` → protocol `APPROVAL_DECISION`. |
| REST | `apps/master/src/approvals/routes.ts` | `/approvals*`, `/projects/:id/policy`. |
| Migration | `apps/master/migrations/0005_approvals.sql` | `project_policies`, `approval_requests`, `approval_decisions` + invariant triggers. |
| Console | `apps/web/src/screens/ApprovalsPage.tsx`, `apps/web/src/api/approvals.ts` | Inbox, detail, Approve/Deny through the existing step-up dialog. |

The policy model lives in the master, not in `packages/scheduler`: the scheduler is a dependency-free state
machine, while the policy needs Zod validation and the master's role model. If the worker later evaluates
policy locally (defence in depth for offline operation), the pure `policy.ts` can move to a shared package
unchanged. Wire transport of `APPROVAL_DECISION` and the ingestion of the worker's `approval_request` event are
the transport's job; they call `evaluate()` and relay the outbox (§5).

## 2. Policy model

### Action catalog and platform policy

| Action | Platform default | Floor (weakest a project may set) |
| --- | --- | --- |
| `git.push_protected` | require approval · admin · step-up · 24 h · high | require approval · admin · step-up · ≤ 7 d |
| `git.merge` | require approval · admin · step-up · 7 d · high | require approval · admin · step-up · ≤ 7 d |
| `git.force_push` | **deny** · critical | require approval · admin · step-up · ≤ 24 h |
| `deploy` | require approval · admin · step-up · 24 h · critical | require approval · admin · step-up · ≤ 7 d |
| `fs.delete_outside_workspace` | **deny** · critical | require approval · admin · step-up · ≤ 24 h |
| `network.egress_non_allowlisted` | require approval · operator · step-up · 1 h · medium | require approval · operator · ≤ 24 h |
| `secret.read` | require approval · admin · step-up · 1 h · high | require approval · admin · step-up · ≤ 24 h |
| `runtime.dangerous_tool` | require approval · operator · step-up · 1 h · medium | allow |
| `job.budget_increase` | require approval · admin · step-up · 24 h · medium | require approval · operator · ≤ 7 d |

Each rule has `outcome` (`allow | require_approval | deny`), `approverRole` (weakest role that may decide:
operator < admin < owner; viewers never), `requiredApprovals` (1–5 distinct users; one deny decides),
`expiresInSec`, `stepUp` and `risk`. Unknown action strings reported by a runtime are classified as
`runtime.dangerous_tool` — never as something weaker.

### Authority order (ADR-0010 §1)

1. **Platform** — the constants above. Changing them is a code change with review.
2. **Project** — rules stored per project by an owner/admin with a fresh step-up. Each field may be
   tightened freely and relaxed only down to the floor. `PUT` rejects a weaker rule
   (`policy_below_platform_floor`, listing `action.field`); `resolveRule` clamps again at evaluation (defence
   in depth, e.g. if the floor is raised later).
3. **Job** — `JobSpec.approvalPolicy` from the authenticated user's prompt can only tighten:
   `deny-sensitive` turns `require_approval` into `deny`, `ask-all` turns `allow` into `require_approval`.
4. **Repository content** — has no authority. `evaluate` accepts a `repositoryPolicy` argument only so the
   attempt is recorded (`repositoryPolicy: "ignored"` in the audit metadata); it never changes the result.
   There is no API that reads policy from a repository.

The resolved rule is **snapshotted** into the request (role, count, step-up, expiry, policy version), so a
policy edit never changes requests that are already open.

## 3. Data model (migration 0005)

| Table | Key columns | Invariants (DB-enforced, SQLSTATE `RA000` / `insufficient_privilege`) |
| --- | --- | --- |
| `project_policies` | `(project, version)`, `rules` jsonb, `reason`, `created_by`, `created_at` | Append-only (no UPDATE/DELETE/TRUNCATE); a new version must be exactly previous + 1. |
| `approval_requests` | `id`, `job_id`, `attempt_id`, `epoch`, `approval_key`, `kind` (`gate`/`in_run`), `action`, `requested_action`, `risk`, `summary`, `requested_by_type/id` (`runtime`/`worker`/`system`), `worker_id`, rule snapshot, `status`, `created_at`, `expires_at`, `decided_at`, `decided_by`, `decision_reason` | `UNIQUE NULLS NOT DISTINCT (job_id, attempt_id, approval_key)` (idempotent creation per attempt + approvalId); pending → one terminal status, then immutable; identity/snapshot columns immutable; `approved`/`denied` ⇔ `decided_by` set (humans only); in-run rows carry attempt and worker; no DELETE/TRUNCATE. |
| `approval_decisions` | `request_id`, `decision`, `user_id`, `user_role`, `reason`, `step_up_at`, `decided_at` | Append-only; `UNIQUE (request_id, user_id)` — one vote per user. |

## 4. Engine (`ApprovalService`)

### `evaluate(input) → allow | deny | pending(requestId)`

One transaction, job row locked `FOR SHARE`:

- **Gate** — job in `AWAITING_APPROVAL`; only the `system` (integrator) may ask. The request is bound to the
  job's current attempt and epoch; key defaults to `gate:<action>`.
- **In-run** — job in `STARTING`/`RUNNING`/`VERIFYING`. A runtime/worker must name its attempt and epoch and
  hold the job's live lease (ADR-0004); otherwise `ApprovalStaleError` (audited). The worker holding the lease
  is recorded as the addressee of the decision.
- Anything else (queued, cancelling, terminal) → `ApprovalContextError`.
- `allow`/`deny` from policy are audited (`approval.evaluate`). `require_approval` inserts the request
  (`ON CONFLICT DO NOTHING`); a replay with the same `(attempt, approvalKey)` returns the existing request's
  answer (`pending`, `allow` if approved, `deny` if denied/expired/cancelled) — at-least-once delivery from
  the worker is safe. Reusing a key for another action is rejected.

### `decide(requestId, approve|deny, user, {reason})`

One transaction; lock order **job, then request** everywhere (no deadlocks with `evaluate`/`sweep`):

1. Request not pending → `approval_already_decided` (409).
2. Past `expires_at` → the request is marked `expired` (committed; gate job cancelled, in-run worker told
   `deny`), then `approval_expired` (409).
3. **Stale** — job state, attempt or epoch no longer match, or (in-run) the lease is gone/held by someone
   else → request `cancelled` (committed, worker told), then `approval_stale` (409). This is the "stale epoch
   → refused" rule.
4. Role below the snapshot's `approverRole` → `forbidden` (403). Rule needs step-up and the session's last
   TOTP is older than 10 minutes → `step_up_required` (403).
5. Append the vote (second vote by the same user → 403). Deny (reason mandatory) closes the request;
   approvals close it once `requiredApprovals` distinct users approved.
6. On close: **gate** → `JobStore.transitionWithin(tx, …, approval_granted | approval_denied)` as the user,
   with `expectedVersion` — the job transition, its history, its `job.transition` outbox row, the request
   update, the vote and the audit events commit together. **In-run** → `approval.decision` outbox row.

Every refusal is audited as `approval.decide` / `denied` with its code. Concurrent deciders: the job/request
row locks serialise them; exactly one closes the request, the other gets 409.

`JobStore` gained `transitionWithin(tx, …)` (same validation as `transition`, inside the caller's
transaction; rejections are audited by the caller). `transition()` is unchanged in behaviour.

### Expiry and stale sweep

`sweep()` closes pending requests that expired or whose job moved on, one transaction each. `main.ts` runs it
every 30 s (`approvalSweepIntervalMs`; tests call it directly). An expired **gate** request cancels the job
(`cancel_requested` by `system`, reason "approval for X expired"): nothing is ever approved by default and the
job does not wait forever.

## 5. Worker contract (for the transport)

Topic `approval.decision` in the existing `outbox` table, payload `ApprovalDecisionOutboxPayload`:
`{requestId, jobId, workerId, status, message}` where `message` is exactly the protocol `APPROVAL_DECISION`
payload `{attemptId, epoch, approvalId, decision, decidedBy}`. Expired/cancelled requests are sent as
`deny` with `decidedBy: "system"` so a waiting runtime never hangs. `toApprovalDecisionMessage(payload,
envelope)` builds and validates the wire message. The worker must drop a decision whose epoch is not its
current lease epoch. Inbound: the transport maps the worker's `EVENT{kind: approval_request}` to
`evaluate({action, approvalKey: approvalId, attemptId, epoch, summary: description, risk, requestedBy:
{type: 'runtime', id: workerId}})` and answers `allow`/`deny` immediately via the same outbox path or waits
for the decision when `pending`.

## 6. REST API

All routes need a full session (route-coverage test lists them). Responses use the generic error body.

| Route | Who | Notes |
| --- | --- | --- |
| `GET /approvals?status=&limit=` | any role | pending: soonest deadline first; otherwise newest first |
| `GET /approvals/:id` | any role | request + decisions (usernames, roles, reasons) |
| `POST /approvals/:id/approve` `{reason?}` | approver role, CSRF, step-up if the rule says so | 200 `{request, final, jobState}` |
| `POST /approvals/:id/deny` `{reason}` | same | reason required |
| `GET /projects/:id/policy` | owner/admin | stored rules, version, effective rules with sources, platform defaults + floor |
| `PUT /projects/:id/policy` `{expectedVersion, rules, reason?}` | owner/admin, CSRF, step-up | new version; 409 on version conflict; 400 below floor |

Step-up on approve/deny is enforced by the engine from the request's rule (the floor makes it mandatory for
merge, protected push, force push, deploy, destructive deletes, secrets and budget increases), so the same
403 `step_up_required` reaches the console's step-up dialog. Policy writes always need step-up (route
`preHandler` and engine).

## 7. Console

`/approvals` (and `/approvals/:id` for deep links from notifications): Pending/Decided filter, inbox cards
with risk badge, action, project and short job id, summary (two lines), requested and expiry times; detail
with the full summary in a scrollable `<pre>` labelled "reported by the runtime; unverified", job, effect
("the job finishes when approved" vs "the running agent waits"), who may decide, approvals x of y and past
decisions; Approve / Deny with a reason (required to deny, checked client-side) through `StepUpProvider.run`
— a `403 step_up_required` opens the existing dialog and retries once; cancelling the dialog leaves no error.
The inbox refreshes every 30 s. Master error messages are shown verbatim.

Since [p10-approval-readable](p10-approval-readable.md) an in-run request of a newer worker shows the agent's own
description (labelled unverified), the command as it runs (copy, collapse, formatted view), its fields and a static
"what this touches" reading instead of the raw summary, which stays available under "Raw text from the machine".

## 8. Tests

- `apps/master/test/unit/approvals-policy.test.ts` (15) — catalog/default consistency; always-human actions
  can never be allowed (write check + clamp); role/step-up/expiry floors; tightening allowed; **exhaustive**
  9 actions × 3 outcomes × 3 roles × 2 step-up × 3 counts × 4 expiries never resolves below the floor and
  accepted input is never altered by the clamp; job layer only tightens; hostile repository content changes
  nothing and is reported ignored; classification; role order; staleness; protocol message builder.
- `apps/master/test/integration/approvals.test.ts` (18, throw-away Postgres) — approve moves AWAITING_APPROVAL →
  SUCCEEDED with history actor = user; double decide refused + audited; two racing approvers → exactly one
  wins; deny needs a reason and fails the job; operator/viewer refused without side effects; missing step-up
  refused then accepted after step-up; CSRF required; expired request cannot be approved and cancels the job;
  sweeper expiry; in-run idempotency per `(attempt, approvalId)`, fencing (wrong epoch/worker/attempt),
  outbox payload, replay answers from the decision; stale after cancel and after lease loss + resume under a new
  epoch; only the master opens gates; repository policy ignored and audited; job `deny-sensitive`; policy
  RBAC/step-up/floor/version conflict/audit; N = 2 approvals with distinct users; DB backstops; audit chain
  verifies.
- `apps/master/test/integration/route-coverage.test.ts` — the six new routes reject anonymous, pending and
  enrollment sessions.
- `apps/web/test/approvals.test.tsx` (7) — empty state; inbox fields; hostile summary rendered as text (no
  element created); detail; approve → 403 step-up → dialog → retry with CSRF header; deny reason validation;
  verbatim errors; cancelled step-up shows nothing. The e2e auth flow now checks the Approvals empty state
  against the real master.

## 9. Security review

| Threat | Mitigation | Residual / follow-up |
| --- | --- | --- |
| **T-INJ-2** injected "push to main / merge / deploy" | Enforcement outside the model: the runtime can only *ask*; the platform floor makes merge, protected push, force push, deploy and deletes outside the workspace require a human (never `allow`) at write time and again at evaluation; only `user` actors can approve (state machine + DB check `decided_by` + role check); repository content is not an input. | The worker must actually route these operations through `evaluate` (no git write credentials in untrusted jobs, ADR-0010 §3) — p4-git-flow / transport. |
| **T-INJ-3** malicious change merged | Gate approval of the merge by admin/owner with step-up; requests show project, job, effect; N-of-M approvals available per project. | Diff review UI and CI-config/dependency flags are p4-git-flow / p5-live. |
| Approval of the wrong thing (stale decision) | Requests are bound to job + attempt + fencing epoch (+ worker for in-run); a decision after the job moved on is refused and the request cancelled; the worker drops decisions for other epochs; rule snapshot prevents policy edits changing open requests. | — |
| Replay / duplicate worker messages | Idempotent creation per `(job, attempt, approvalKey)`; replays get the stored answer. | — |
| Privilege escalation via policy | Policy writes: owner/admin, fresh step-up, CSRF, optimistic version; floor cannot be weakened; every write and refusal audited with the changed actions. | Since p5-rbac-api: project-scoped visibility and decisions with the caller's project role ([p5-rbac.md](p5-rbac.md)); policy edits stay owner/admin (global). |
| **T-OPS-3** repudiation | Votes append-only with user, role, reason and the TOTP time that authorised them; requests immutable once decided; every evaluate/request/decide/expire/cancel/refusal in the hash-chained audit log in the same transaction (refusals right after rollback). | Table owner can disable triggers; production uses a non-owner role (p1-data-services). |
| CSRF / session misuse | Double-submit CSRF on every POST/PUT (existing hook, tested); step-up for privileged decisions. | — |
| Stored XSS via summaries | Summaries/requested actions are untrusted text, length-limited (2000/128), NUL stripped, rendered by React as text (`<pre>`), never HTML; test proves an `<img onerror>` summary creates no element; CSP unchanged. | — |
| Approval fatigue / hanging jobs | Expiry per rule; expired gate → job cancelled; expired in-run → worker told `deny`. Inbox sorted by deadline. | Notifications (p5-notifications) to reach approvers. |
| Information leakage | Errors carry codes/paths only; audit metadata holds identifiers, action, codes and the human's reason — never the summary. | Summaries may contain sensitive command lines; viewers can read them (p5-rbac-api may restrict). |

## 10. Rollback and operations

Forward-only migration 0005 only adds objects (independent of 0004). Rolling back the build after it ran
needs a corrective migration (the runner refuses unknown versions); the previous build ignores the new tables.
Operational signals for p6-otel: pending request count and age, expiries per hour (`approval.expire`), stale
cancellations (`approval.cancel` — partitions or slow approvers), `approval.decide` denials by code
(`step_up_required`, `forbidden`), `policy.update` events.
