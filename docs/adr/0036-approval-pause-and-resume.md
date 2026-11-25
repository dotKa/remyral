# ADR-0036: A job waiting on an approval is paused, never failed by the wait; it resumes on the same machine

- **Status:** Accepted
- **Date:** 2026-10-18
- **Deciders:** owner (request 2026-10-18: "A job waiting on an approval must not fail shortly afterwards.
  After a while it can be marked waiting-approval / paused / stale. When it fails we can't continue the job.");
  implemented by `p10-approval-pause`
- **Amends:** p4-approvals expiry semantics for **in-run** requests of pause-capable workers (ADR-0010 enforcement and
  the platform floor are unchanged); ADR-0004 gains a second "same attempt, new epoch" path next to LOST →
  `reconcile_resume`.
- **Related:** docs/design/p10-approval-pause.md (design + security review §12), ADR-0003, ADR-0004, ADR-0008, ADR-0010,
  ADR-0031 (sub-jobs), AGENTS.md rules 6, 7, 10, 11.

## Context
In-run approvals (a runtime asks before a tool call) were bounded by two clocks: the worker's adapter denied a pending
call after 15 minutes (fail closed) and the master expired the request at its rule's expiry (1 h for runtime tool
calls). Owners who decided after 15 minutes approved something no runtime waited for any more; the run continued
"denied", usually ending failed or without the work, and a failed job is terminal. Meanwhile the waiting run held its
lease and its machine slot and the wait counted against `maxDurationSec`.

## Decision
1. **Stale, then paused — never failed by the wait.** For in-run requests of jobs whose worker advertises
   `approval-pause-v1`, the request does not expire while the run waits. After the project's `staleAfter` (default
   15 min) the request is marked stale (notification `approval.stale`, chat note, once). After `pauseAfter` (default
   60 min) the master sends a durable, fenced `PAUSE_JOB`; the worker stops the runtime gracefully, keeps the attempt's
   workspace, sandbox dir and runtime session, and reports `JOB_RESULT.paused`. The job goes RUNNING → **PAUSED**
   (worker actor, fenced); the lease is released (slot free) and the attempt stays open. The request stays open until
   the project's retention (default 7 days, at most `MAX_EXPIRY_SEC`); only an explicit deny, a cancel or the end of
   the retention ends the job. Gate approvals and older workers keep the p4 behaviour.
2. **Resume = the same attempt on the same machine.** A decision while paused is copied to the pause episode (no
   APPROVAL_DECISION: nothing waits). Before placement the master re-validates the policy (a rule that now denies the
   action turns the approval into a denial), the approver's role in the project and the machine; then PAUSED →
   RESERVED (`resume_paused`, same attempt id, epoch + 1) on that worker only, with `ASSIGN_JOB.execution.resume`. A
   worker that cannot resume declines → back to PAUSED (`resume_declined`), never queued elsewhere; the console then
   offers "Restart from scratch" (PAUSED → QUEUED, a new attempt) or Cancel.
3. **The decision binds to the exact action.** The resumed runtime is told the decision as data and re-runs the call;
   the master answers that request from the decision only if its fingerprint (sha256 of action, requested action and
   summary) is identical — once for an approval, always for a denial. Anything else asks a human.
4. **Truthful resume.** Each runtime continues its own session where its pinned SDK / protocol supports it (Claude Code
   `resume`, Codex `thread/resume`, OpenCode session storage, Pi `--session-id`); where the `resume` capability is not
   offered for the job, the worker starts a fresh session with a continuation prompt (earlier progress + decision) and
   the job page says so.
5. **Time and budgets.** Approval waits and paused time do not count against `maxDurationSec` (the worker's run clock
   pauses; the resume gets the remaining time). Token / turn / cost budgets are per job and carry over.

## Alternatives considered
- **Keep the run alive and only extend the timeouts.** Rejected: holds a machine slot (and on subscription logins the
  only slot) for hours, and a worker restart loses the run anyway.
- **End the attempt and start a new attempt on resume.** Rejected: a new attempt id means a new worktree path and
  attempt branch (ADR-0004 trailers, git flow verification), so the kept workspace and the runtime session (keyed by the
  cwd) could not be reused without special cases.
- **Deliver the decision to the stopped tool call itself.** Not possible across a process stop for any pinned runtime
  (the call was interrupted); the fingerprint-bound re-run gives the same effect without trusting the runtime's
  transcript.
- **Let the request expire after the floor's `maxExpiresInSec` while paused.** Rejected: it recreates the failure the
  owner reported; nothing runs while paused and the decision is re-validated at resume.

## Consequences
- New job state PAUSED (attempt-open, no lease), triggers `pause_confirmed`, `resume_paused`, `resume_declined`,
  `restart_paused`, `reconcile_pause`; migration 0079 (enum value, `job_pauses`, request markers, project settings,
  notification kinds, chat draft kind).
- Worker release with `approval-pause-v1` (PAUSE_JOB, parked records, workspace reopen, run clock); master first.
- A paused request may stay open up to 7 days — longer than some rules' `maxExpiresInSec`; documented exception, only
  while its job is paused and only for pause-managed in-run requests.
- Kept workspaces use disk on the worker for up to the retention; bounded by one episode per job, pruning and cancel.

## Verification
Scheduler state-machine tests (exhaustive matrix + PAUSED block); protocol tests; adapter park/resume tests per runtime;
worker tests (run clock, parked store, pause → park → resume, decline, discard); master integration with real worker
daemons and the fake runtime (wait → stale → paused → approve → resumed and the tool runs; deny; workspace missing →
restart; machine gone; retention; continue; RBAC; time accounting); web tests. UNVERIFIED live: resume of the real
runtimes after a pause on fleet machines (see the design note §13).
