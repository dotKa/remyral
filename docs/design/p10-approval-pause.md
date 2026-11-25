# p10-approval-pause — a job waiting on an approval is paused, never failed by the wait

- **Task:** `p10-approval-pause`. **Date:** 2026-10-18.
- **Owner request:** "A job waiting on an approval must not fail shortly afterwards. After a while it can be marked
  waiting-approval / paused / stale. When it fails we can't continue the job."
- **Decision:** [ADR-0036](../adr/0036-approval-pause-and-resume.md) (pause instead of expiry for in-run approvals;
  resume of the same attempt on the same machine; decisions bound to the exact action).
- **Builds on:** [p4-approvals](p4-approvals.md) (requests, expiry sweep, in-run decisions over the outbox),
  [p4-job-state-machine](p4-job-state-machine.md), [p4-orchestration](p4-orchestration.md) (leases, fencing, LOST →
  `reconcile_resume` of the same attempt), [p6-approval-mode-switch](p6-approval-mode-switch.md),
  [p6-chat-notify](p6-chat-notify.md) (watches), [p8-orchestration](p8-orchestration.md) (sub-jobs),
  [p9-queue-priority](p9-queue-priority.md) (queue screen, slot accounting).
- **Migration:** 0079 (0078 = p10-bedrock-integration-panel). **Worker release:** yes
  (`approval-pause-v1`). **Protocol:** additive in 1.0.

## 1. What happens today (findings, 2026-10-18)

| Piece | Behaviour | Where |
| --- | --- | --- |
| In-run approval wait on the worker | Every adapter's approval broker denies a pending tool call after `timeouts.approvalMs` = **15 min** (worker default), fail-closed. The runtime sees "denied" and usually gives up or ends without the work. | `apps/worker/src/jobs/runner.ts` `DEFAULT_TIMEOUTS.approvalMs`; `session-kit/approval-broker.ts`; OpenCode / Pi own timers |
| The request on the master | Stays `pending` until the rule's `expiresInSec` (`runtime.dangerous_tool`: 1 h; floor ≥ 60 s, ≤ 1 d). Approving between 15 min and 1 h is accepted by the master but the decision reaches no runtime (`no pending approval`): the console said "approved" while the run had already been told "denied". | `apps/master/src/approvals/policy.ts`, `service.ts` |
| Expiry | The sweeper closes it `expired` and sends `deny` to the worker (in-run); a gate request cancels the job. | `ApprovalService.sweep` / `close` |
| Job / attempt | Nothing marks a long wait: the job stays RUNNING, holds its lease (renewed every third of 90 s) and its slot, and the wait counts against `maxDurationSec` (a 30-min job dies of `max_duration_exceeded` while waiting). After a deny the job ends `failed` or succeeds without the step; a FAILED job is terminal (cannot be continued). | runner `durationTimer`, `orchestrator` leases, `queue` slot counting (`slotLease`) |
| Notifications | `approval.requested` once; `approval.expiring` near the rule expiry; chat watch "approval needed" once per request. | `notifications/producers.ts`, `chat/watches.ts` |
| Chat-created jobs / automations | p6-chat-job-defaults: automations have their own "approval timeout" (default 60 min) that cancels the run — unchanged (an unattended automation run is still cancelled by its own timeout, §11). | `automations/service.ts` |

## 2. Shape

```
 runtime asks (approval_request) ─▶ master evaluate → request pending
     │  job's worker advertises approval-pause-v1: pause_after_at = created + pauseAfter; the request does not expire
     │  at its rule expiry; the runtime's own wait lasts pauseAfter + 15 min (backstop if the master never pauses)
     │
     ├─ staleAfter (project, default 15 min) ─▶ request.stale_at; outbox approval.pause{stale}
     │        → notification approval.stale (deciders), chat watch note "still waiting for your approval" (once)
     │
     ├─ pauseAfter (default 60 min) ─▶ job_pauses row 'pausing', request.pause_requested_at,
     │        request.expires_at := now + retention (default 7 d), PAUSE_JOB {attempt, epoch, approvalId} to the worker
     │        worker: stop runtime (cancel), park session (adapter.parkSession), keep worktree + sandbox dir + runtime
     │        state, write parked record, JOB_RESULT{outcome: cancelled, paused{resume, activeMs, sessionId}}
     │        master: RUNNING --pause_confirmed--> PAUSED (lease released → slot free; attempt stays open, 'paused')
     │        → notification job.paused, chat watch note (once)
     │
     ├─ human decides (approve / deny with reason) while pausing or paused
     │        request closed (approved / denied), job_pauses.decision copied, status 'resuming'
     │        (no APPROVAL_DECISION to the worker: the runtime that asked is stopped)
     │
     ├─ dispatcher step "resume-paused": re-validate policy and the decider's role; place on the SAME worker only
     │        (requirements.workers = [worker], job's own priority class); PAUSED --resume_paused--> RESERVED (same
     │        attempt id, epoch + 1); ASSIGN_JOB{execution.resume{pausedEpoch, approvalId, action, summary,
     │        decision, activeMs}}
     │        worker: verify parked record (job, attempt, epoch, workspace inside root, trusted-git snapshot),
     │        reopen the worktree / scratch dir, adapter.resumeParked (session) or spawn + continuation prompt,
     │        max duration = limit − activeMs; the runtime re-runs the call → master answers it from the decision
     │        (fingerprint match, one-shot for approve; deny is sticky) → the tool runs / the denial is delivered
     │
     ├─ worker gone / workspace missing ─▶ LEASE_ACK declined "paused_workspace_missing" → RESERVED
     │        --resume_declined--> PAUSED, job_pauses.blocked_reason; console offers "Restart from scratch" / Cancel
     │
     └─ retention ends without a decision ─▶ request expired, job PAUSED --cancel_requested--> CANCELLED,
              CANCEL_JOB to the worker (discard the kept workspace)
```

## 3. State machine (packages/scheduler)

New state **PAUSED** (appended to `JOB_STATES`; migration 0079 `ALTER TYPE job_state ADD VALUE 'PAUSED'`). It is an
**attempt-open** state without a lease, like LOST: the attempt is not ended, so the resume continues *the same
attempt* (same attempt id → same worktree path `jobs/<job>/<attempt>`, same attempt branch `rac/<job>/<attempt>`,
same sandbox dir) under a new fencing epoch — exactly the existing `reconcile_resume` pattern of LOST.

| From | Trigger | To | Actor | Notes |
| --- | --- | --- | --- | --- |
| RUNNING, STARTING | `pause_confirmed` | PAUSED | worker (lease holder) | reason required; the lease is released (`pause_confirmed`), attempt state `paused` |
| PAUSED | `resume_paused` | RESERVED | system, user | a lease trigger (`JobStore.acquireLease`): same attempt, same worker, epoch + 1 |
| RESERVED | `resume_declined` | PAUSED | worker | the worker could not resume (workspace missing / busy); never QUEUED (no silent restart elsewhere) |
| LOST | `reconcile_pause` | PAUSED | system, user | a resume reservation that was never acknowledged and is not running on its worker |
| PAUSED | `restart_paused` | QUEUED | user, system | "Restart from scratch": the paused attempt ends `cancelled`, the next reservation is a new attempt anywhere |
| PAUSED | `cancel_requested` | CANCELLED | user, system | immediate (nothing runs); the worker is told to discard the kept workspace |

Guards stay as before: only a worker holding the live lease can pause (fencing), only humans approve, a worker can
never leave PAUSED. Tests: `packages/scheduler/test/machine.test.ts` (exhaustive state × trigger matrix plus the
p10 block).

## 4. Data model (migration 0079)

- `job_state` + `PAUSED`; `job_attempts.state` + `paused`.
- `projects.approval_stale_after_sec` (default 900, 60 s–24 h), `approval_pause_after_sec` (3600, 2 min–24 h,
  > stale), `approval_pause_retention_sec` (604 800 = 7 d, 1 h–7 d).
- `approval_requests` + `stale_at`, `pause_after_at` (set at creation for pause-managed requests),
  `pause_requested_at`, `fingerprint` (sha256 of the JSON array `[action, requested_action, summary]`). The 0005 guard is replaced:
  a pending request may stay pending only to set the pause markers once, and its `expires_at` may move later only in
  the same update that starts the pause. Decided requests stay immutable.
- `job_pauses` — one row per pause episode, at most one open per job (§2 statuses), with the decision copy, the
  resume mode and `active_ms` reported by the worker, `blocked_reason`, the one-shot `carryover_used_at`, notice
  markers and `ended_at` / `end_reason`.
- notification kinds `approval.stale`, `job.paused`; chat draft kind `job_resume`.

## 5. Master

| Piece | Where |
| --- | --- |
| Settings (read/write, bounds, defaults) | `apps/master/src/approvals/pause-settings.ts` |
| Pause service: stale/pause/expiry tick, pause confirmation, decision hand-off, resume / restart / cancel, carry-over, view | `apps/master/src/approvals/pause.ts` |
| Engine changes (`pause_after_at` + fingerprint at evaluate, carry-over answer, sweep/decide/staleness of paused requests) | `apps/master/src/approvals/service.ts` |
| Resume dispatch on the same worker | `Orchestrator.dispatchResumes()` (tick step before `dispatch`), `#assign(…, resume)` |
| Inbox: `JOB_RESULT.paused` → `pause_confirmed`; resume decline → `resume_declined` | `apps/master/src/orchestration/inbox.ts` |
| Lapsed resume reservation → `reconcile_pause` | `Orchestrator.reconcileLost` |
| REST | `apps/master/src/approvals/pause-routes.ts` |
| Notifications | outbox topic `approval.pause`; producers `approval.stale`, `job.paused` |
| Chat | watches: `stale:<request>` / `paused:<pause>` occurrences (once each); tool `draft_job_resume` (card) |
| Sub-jobs | `subtaskStateOf('PAUSED') = running` + reason `paused_awaiting_approval` |
| Queue | `QueueView.paused` (separate section); paused jobs hold no lease → no slot |

**Which requests are pause-managed.** In-run requests (`kind = in_run`) of a job whose lease holder advertises
`approval-pause-v1` at evaluation time, except machine-admin jobs (their elevated commands have their own broker,
ADR-0021). Gate requests (merge / protected push at AWAITING_APPROVAL) keep their p4
semantics (nothing runs while they wait; their expiry cancels). Requests of older workers keep the p4 behaviour.

**Stale.** `created_at + staleAfter ≤ now`, still pending, job RUNNING/STARTING: set `stale_at`, outbox
`approval.pause {event: stale}` → `approval.stale` notification to the deciders (dedupe per request) and the chat
watch note. The job is "stale" while its open request is (`approvals[].staleAt` on the job read model, badge).

**Pause.** `pause_after_at ≤ now`, still pending, job RUNNING/STARTING, lease live, holder still advertises the
feature: in one transaction (job row locked, then request) insert `job_pauses('pausing')`, set
`pause_requested_at` and `expires_at = now + retention`, enqueue `PAUSE_JOB` (durable, fenced) to the lease holder,
audit `approval.pause`. If the run finishes, fails or is cancelled before the worker pauses, the normal transition
wins; the tick closes the episode (`cancelled`, "the run ended before it paused") and the request goes the usual way
(stale → `cancelled`).

**Pause confirmation** (inbox, `JOB_RESULT` with `paused` while RUNNING/STARTING under the live lease and an open
`pausing` episode for this attempt): `pause_confirmed` (worker actor, fenced), episode → `paused` with resume mode,
`active_ms`, session id; if the request was decided meanwhile → `resuming`. A `paused` result without an episode is
treated as an unexpected stop (`attempt_failed`, "paused without a pause request").

**Decisions.** `decide()` on a request with `pause_requested_at`: staleness allows the job in
RUNNING/STARTING/PAUSED with the same attempt (lease checks skipped — nobody is waiting on a lease); the vote and the
request close as usual; instead of `APPROVAL_DECISION` the decision is copied to the episode, which becomes
`resuming` (if PAUSED) or stays `pausing` with the decision (resumed right after the confirmation).

**Resume dispatch** (tick step `resume-paused`, before the normal dispatch, serialised by the dispatch lock):
for each `resuming` episode of a PAUSED job: (1) **re-validate**: resolve the request's action again under the
current project policy and the job's approval mode — `deny` now → the decision becomes "denied (the approval policy
now denies it)"; for an approval, the deciding user must still have a role ≥ the request's approver role in the
project (`projectRecipients`), else the episode is blocked ("the approver no longer may approve this action") — a
decided request is immutable and cannot be asked again without a run, so only Restart from scratch / Cancel remain
(fail closed); (2) the worker must still exist, not be archived or quarantined and still advertise the feature —
else `blocked_reason` ("machine gone"); offline → wait (the queue shows the placement reason); (3) placement
with `requirements.workers = [worker]`, the job's priority class and every other eligibility check (runtime still
installed, slots, profile) — `waiting` keeps the episode `resuming` with the reasons on the queue screen;
`infeasible` → `blocked_reason`; (4) `acquireLease` (`resume_paused`), `ASSIGN_JOB` with `execution.resume` and
`execution.approvalWait`. Admissions (quotas, DAG) are not re-run: the job was admitted and is mid-attempt; budgets
stop it by usage as before.

**Carry-over (approval binds to the exact action).** In the resumed attempt the runtime asks again (new approval id).
`evaluate()` computes the fingerprint; if the job's latest resumed episode decided the same fingerprint: `approve`
→ `allow` **once** (`carryover_used_at`, audited `approval.carryover`), `deny` → `deny` (sticky for that attempt).
Any other action or input asks a human as usual. A changed policy still applies first (a `deny` rule wins).

**Retention.** Episodes `paused`/`resuming` past `retain_until`: request `expired`, job `cancel_requested` (system,
"no decision within the pause retention"), `CANCEL_JOB` to the worker for the paused attempt (discard), episode
`expired`.

**Restart from scratch / Cancel / Resume now** (`POST /jobs/:id/resume {mode}`; cancel is the normal
`POST /jobs/:id/cancel`): restart → `restart_paused` (attempt ends cancelled, job QUEUED keeps its priority; the
request is closed `cancelled`; `CANCEL_JOB` discards the old workspace); resume → only with a decision (409
`decision_required` otherwise); clears `blocked_reason` and retries placement now.

**Continue after an expired approval** (`POST /jobs/:id/continue`, best effort): a FAILED or CANCELLED job whose last
attempt ended after one of its approval requests `expired` (the pre-p10 failure mode, or a gate expiry) gets a **new**
job with the same spec (same project, runtime, sandbox, approval mode, limits; re-authorised as the caller) and a
continuation prompt: the original prompt, the previous attempt's result summary (redacted, bounded) and "the request
to <action> (<summary>) expired before anyone decided; ask again if you still need it". No approval carries over to
the new job.

## 6. Worker (`approval-pause-v1`)

| Piece | Where |
| --- | --- |
| Parked records (one JSON per job under `<root>/.remyral/parked/`, 0600; prune at retention) | `apps/worker/src/jobs/parked.ts` |
| Run clock that does not count approval waits (max duration) | `apps/worker/src/jobs/run-clock.ts` |
| PAUSE_JOB handling, parking in `#run` / `#runScratch`, resume path, continuation prompt | `apps/worker/src/jobs/runner.ts`, `apps/worker/src/jobs/resume.ts` |
| Reopen a kept worktree / scratch dir / attempt sandbox dir | `WorkspaceManager.reopen` / `reopenScratch`, `openAttemptGitView` |

- **Approval wait.** With `execution.approvalWait` the adapter's `approvalMs` is `pauseAfter + 15 min` (backstop:
  the old fail-closed deny if the master never pauses, e.g. unreachable). Without it the 15-min default stays.
- **Run clock.** The duration timer becomes a pausable clock: it stops while the runtime waits on an approval
  (between an `approval_request` event and its decision / the next tool event) and resumes after. A resumed attempt
  starts with `activeMs` already used; running out fails with `max_duration_exceeded` as before. The adapter's own
  hard limit is set to the remaining time plus twice the approval wait (a backstop only).
- **PAUSE_JOB** (fenced by attempt + epoch; unknown or stale → ignored): marks the job pausing, aborts the run like a
  cancel but **parks**: after the adapter stopped, `adapter.parkSession(ref)` (session mode) — if absent or it fails,
  continuation mode; the worktree / scratch dir and the attempt sandbox dir (`sandboxes/<job>/<attempt>`: scratch git
  dir, runtime state with transcripts) are **not** released; the parked record stores job, attempt, paused epoch,
  project, kind, paths (relative to the root), base commit + mirror, the trusted-git snapshot, the parked session,
  a bounded redacted transcript summary (last assistant messages and tool calls, for continuation mode), `activeMs`,
  `retainUntil`. Then `JOB_RESULT{outcome: cancelled, paused{…}}`; the slot is free (job leaves `#active`).
- **Resume** (`ASSIGN_JOB` with `execution.resume` for an attempt that has a parked record): preflight checks the
  record (same job / attempt / paused epoch, paths still real directories inside the root, not expired); missing →
  `LEASE_ACK{accepted:false, reason: "paused_workspace_missing: …", declineKind: permanent}`. Then the usual lease
  ack/renew, credential, env and sandbox steps, but the workspace is **reopened** (no fetch / checkout), the git
  metadata is compared with the parked snapshot (T-SBX-4) before and after the run, the adapter is created on the same
  state dir and `resumeParked` continues the session; the first prompt is the continuation note (decision as data:
  "approved by X — re-run exactly that action now" / "denied by X: <reason> — do not do it; continue without it").
  Continuation mode spawns a fresh session with the original prompt parts plus "Earlier progress" (the parked
  summary) and the decision. The parked record is removed once the run started.
- **Cancel of a paused job / restart / retention**: `CANCEL_JOB` for an attempt that is parked (no active job)
  discards it: worktree released as `cancelled` (kept for inspection by the usual retained-failed rule), sandbox dir
  removed, record removed. The worker also prunes records more than 1 h past `retainUntil` on start and hourly.
- **Races.** A resume that arrives while the paused run is still parking is declined as transient ("another attempt of
  this job is running here"); the master keeps the episode `resuming` and retries on the next tick. A decision that
  reaches the worker after PAUSE_JOB (an approval-mode switch resolving it, before the master marked the pause) is
  handed to a runtime that is already stopping — harmless: the master answers the re-run from the decision anyway.

## 7. Runtime resume (adapters)

`AgentAdapter.parkSession(ref)` / `resumeParked(ctx, parked)` (optional; `ParkedSession.state` holds only paths
relative to the adapter's state dir, resolved with `resolveParkedPath` — absolute paths, `..` and escapes are refused,
as are a mismatched runtime or session id). Each `resumeParked` checks the `resume` capability exactly like `resume()`
(honouring `allowUnverified`), validates the spawn context and sends no prompt. Verified against what is pinned in this
repository:

| Runtime | Evidence (pinned) | Park keeps | Resume | `resume` capability |
| --- | --- | --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-agent-sdk` 0.3.296 `sdk.d.ts` `Options.resume` ("Session ID to resume. Loads the conversation history…") | the per-session `CLAUDE_CONFIG_DIR` (`cfg-*`, transcripts; a `kept` lease flag stops cleanup deleting it); local-login: the session id only (transcripts in the owner's login, same cwd) | `query({ options: { resume: <session id> } })`, same cwd + config dir | unverified (live test pending) |
| Codex | vendored app-server protocol `v2/ThreadResumeParams.ts` (`threadId`) | the per-session `CODEX_HOME` (`home-*`, rollouts) | new app-server, `thread/resume { threadId }` | unverified (live test pending) |
| OpenCode | adapter-owned session database + `index/<ses_id>.json` | storage `storage/<uuid>` (already outlives cleanup) | `opencode serve` on the kept database, next `session.prompt` | degraded (same worker only) |
| Pi | RPC CLI flags `--session-dir` / `--session-id` (existing `resume()`) | the transcript dir (already outlives cleanup) | `pi --session-dir <state>/transcripts/<id> --session-id <id>` | degraded (same worker only) |

When `parkSession` is absent or rejects, the worker records **continuation** mode; when `resumeParked` rejects at the
resume (e.g. the capability is not offered for the job: `unverified` without `allowUnverified`, ADR-0008/0012), the
worker falls back to a fresh session with "Earlier progress" (the parked transcript tail) and the decision. The job
page shows the recorded mode; a fallback at resume time is logged by the worker ("the parked session could not be
resumed; continuing in a fresh session").

## 8. Budget and time

- Time paused does not count: the worker's run clock excludes approval waits, and the resumed attempt gets
  `maxDurationSec − activeMs`. The job page shows "paused for …" (sum of episodes).
- Token / turn / cost budgets (`limits.maxTokens|maxTurns|maxCostUsd`) are summed per job from usage events
  (p4-quotas), so they carry over across the pause unchanged.

## 9. Console

- Job page: PAUSED badge and a "Paused — waiting for your approval" panel (since, retain until, machine, decision,
  resume mode), buttons **Resume now** (after a decision), **Restart from scratch**, **Cancel**; "Stale" badge on a
  running job whose request is stale; "Continue" on a FAILED/CANCELLED job eligible for §5 Continue.
- Queue: a separate "Paused (waiting for approval)" section; paused jobs do not occupy machine slots.
- Project → Policy: "Long approval waits" (stale after, pause after, keep paused for).
- Approvals: "Stale" and "Job paused" badges; the effect line says the job resumes on decision.

## 10. Chat and notifications

- `approval.requested` once per request (unchanged); `approval.stale` once per request; `job.paused` once per episode.
- Chat watch with `approval_requested`: "approval needed" once per request, "still waiting for your approval" once
  per stale request, "paused — will resume when you decide" once per episode.
- Tool `draft_job_resume {jobId, mode: resume | restart}`: a card the user confirms (role `jobs.resume`); after the
  owner approved, the job resumes by itself — the card is for "Resume now" / "Restart from scratch".

## 11. Sub-jobs and automations

- A paused child reports `running` with reason `paused_awaiting_approval` ("child paused awaiting approval") to the
  parent's `wait_subtask`; the parent keeps waiting (its own run clock keeps running only while it is active).
- Automation runs keep their own approval timeout (p6-automations-next): it cancels the job, paused or not.

## 12. Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| A resumed job gains something it was not granted | The resume continues the same attempt with the same spec, sandbox profile, approval mode, secret references and project policy (re-read at assignment like any dispatch). The decision is delivered as data in a prompt; the action itself still goes through `evaluate` — answered from the decision only for the **identical** fingerprint (action, requested action, summary), once for an approval; any other call asks a human. | A runtime could phrase the re-run with a different summary → it simply asks again (fail closed). |
| Policy changed while paused | At resume the rule is resolved again: a now-`deny` rule turns the decision into a denial; carry-over checks the rule first. The approver must still hold the approver role in the project, else no resume (Restart / Cancel only). | — |
| Stale / replayed resume | Same-attempt resume only on the worker that paused it, under a new epoch (lease token, fencing); the parked record must match job, attempt and paused epoch; a duplicate `ASSIGN_JOB` for a running attempt is acknowledged, never run twice. | — |
| Kept workspace tampered while paused (T-SBX-4) | The trusted-git snapshot taken at the attempt start is stored with the record and compared before the resumed run and before publishing. Paths are stored relative to the root and re-validated (real directories inside the root). The record is 0600 under the worker-owned root. | Host users with the worker's uid can still edit files in the worktree — same as during a run. |
| Request open for days | Only pause-managed in-run requests, only while their job is paused, at most the retention (≤ 7 d = `MAX_EXPIRY_SEC`). Nothing runs while waiting; the decision is re-validated. A gate request keeps its rule expiry. | Documented exception to the rule `maxExpiresInSec` floor for the duration of a pause. |
| Resource exhaustion (kept workspaces) | Bounded retention (1 h–7 d), one open episode per job, disk check at resume, pruning on start and hourly; a paused job holds no slot. | — |
| Repudiation (T-OPS-3) | Every pause, confirmation, decision hand-off, carry-over, resume, restart, retention cancel and refusal is audited (`approval.stale`, `approval.pause`, `job.pause.*`, `approval.carryover`); transitions in the append-only history. | — |
| Untrusted text in prompts | The request summary and deny reason are runtime / human text: bounded, passed to the agent as fenced data, never as instructions with authority (ADR-0010). | — |

## 13. Tests

- Scheduler: state × trigger matrix incl. PAUSED, and a p10 block (entered only by the lease holder or a lapsed
  resume, left only by resume / restart / cancel, never by a worker) — `packages/scheduler/test/machine.test.ts`.
- Protocol: PAUSE_JOB (sequenced, fenced), JOB_RESULT.paused, execution.approvalWait / resume, bounds —
  `packages/protocol/test/approval-pause.test.ts`.
- Adapters: park / resume per runtime with the existing fakes (Claude SDK port, Codex app-server, OpenCode server, Pi
  RPC): park after cancel, cleanup keeps the parked state, a fresh adapter instance resumes the same session id,
  tampered paths refused, capability gating — `packages/agent-adapters/test/runtimes/claude-code/park.test.ts`,
  `test/runtimes/codex/park.test.ts`, `test/opencode-park.test.ts`, `test/pi-park.test.ts`, `test/parked.test.ts`.
- Worker: run clock, parked store, continuation note, PAUSE_JOB → park → JOB_RESULT.paused (slot free), resume in
  session and continuation mode, decline when the record is missing, discard on CANCEL_JOB, approval wait timeout,
  reopen of a real worktree and git view — `apps/worker/test/approval-pause*.test.ts`.
- Master unit: fingerprint, staleness of paused requests, settings bounds, sub-job state, notification kinds —
  `apps/master/test/unit/approval-pause.test.ts`.
- Master integration (real Postgres, real worker daemons over WebSocket, fake runtime) —
  `apps/master/test/integration/approval-pause.test.ts`: wait → stale (notification) → paused (lease released, attempt
  open, worker slot free, workspace parked, queue section, viewer refused, resume before a decision refused) → approve
  → the same attempt resumes on the same machine with its session, the re-asked call is answered from the decision
  (one request, `approval.carryover`) and the tool runs; deny → resumed with the denial, no tool run; kept workspace
  missing → `resume_declined`, blocked → Restart from scratch (new attempt, old one `cancelled`); machine gone (archived)
  → blocked → Cancel; retention end → request expired, job cancelled, worker discards; Continue of a job whose approval
  expired; settings RBAC / step-up / bounds; time accounting (approval wait = pause + backstop, `activeMs`, paused time).
- Web: `apps/web/test/approval-pause.test.tsx` (panel, buttons, 409 verbatim, Continue, queue section, policy card
  with step-up, approval badges, hostile summary as text).

**UNVERIFIED (needs real runtimes / machines):** a real Claude Code / Codex / OpenCode / Pi session parked and resumed
after a pause on a fleet machine (the `resume` capability of Claude Code and Codex is still `unverified`, so without
`allowUnverified` they continue in a fresh session); pause / resume under the container profile and with Windows
per-job accounts (reopened worktree + git view; unit-tested only); scratch (workspace-project) jobs end to end (same
code path as repository jobs, no runner test).

## 14. Rollout, rollback, operations

- Deploy the master first (migration 0079; the new feature string must be known before a worker advertises it), then
  release the worker. Older workers: no pause, the old 15-min local deny, unchanged.
- Rollback: the master code can be rolled back after 0079 (additive columns, enum value unused by older code — a job
  already PAUSED would not be dispatched by older code; cancel paused jobs before rolling back).
- Metrics / ops: audit actions above; queue screen "Paused" count; worker logs `job paused` / `job resumed` /
  `parked workspace pruned`.

## 15. Addendum (2026-10-18, live on win-1)

Two fixes, recorded in [p10-claude-login-health.md §8](p10-claude-login-health.md#8-addendum-two-p10-approval-pause-fixes-from-the-same-live-session):
a workspace (scratch) attempt on a sandboxed worker was refused on resume as "the sandbox configuration of this worker
changed since the pause" (the git-view comparison applied to scratch attempts, which never have one) — now compared for
repository attempts only, and every refusal logs the differing field; and the `error_during_execution` result of the
interrupt a pause asks for is no longer streamed as an error event.
