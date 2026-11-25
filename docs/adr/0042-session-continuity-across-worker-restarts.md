# ADR-0042: A running attempt survives a worker restart — checkpoints, restart recovery, half-finished tool calls

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** agent (design), on the P1 feedback "Agents can lose context and progress in long runs. Resuming only from
  a task summary isn't enough. Especially when a worker restarts: session recovery, workspace integrity, and
  half-finished tool calls." Implemented by `p11-session-continuity`.
- **Amends:** ADR-0004 §2 (a restarted worker may resume its attempt under a new epoch instead of only dropping it),
  ADR-0036 (a third pause cause `worker_restart`), ADR-0008 (the `resume` capability of a runtime version becomes
  `supported` only through a live-verified registry entry).
- **Related:** docs/design/p11-session-continuity.md (design + security review §10), ADR-0007 (T-SBX-4), ADR-0010,
  ADR-0039, ADR-0040, AGENTS.md rules 6, 7, 11.

## Context
A worker restart (crash, update, reboot) dropped every running attempt: the new process forgot the restored leases
(F1 — never run an attempt twice), the master reconciled the lost lease to "retry from scratch" (only when verifiably
safe) or "needs human review". The worktree stayed orphaned on disk; `continueFrom` copied artifacts only. Runtime
resume existed but was used only for approval / usage-limit pauses and is unverified for Claude Code and Codex. A tool
call in flight at the crash — possibly a `git push` or a deploy that already happened — was simply lost or re-run.

## Decision
1. **Checkpoints while running.** With ASSIGN_JOB `execution.continuity` (sent only to `session-continuity-v1` workers)
   the worker records the attempt durably before its runtime starts (fsynced record: paths, trusted-git snapshot,
   runtime pids, restarts) and takes cheap periodic checkpoints when something changed and within size caps: a WIP
   commit on the hidden ref `refs/remana/checkpoints/<attempt>/<n>` through a worker-owned index (never the work
   branch, never pushed), or a manifest + copy for workspace jobs; plus the runtime session pointer and the recent tool
   calls. Only metadata goes to the master (CHECKPOINT_REPORT, fenced by the live lease).
2. **Restart recovery, same attempt, new epoch.** Before its first heartbeat a restarted worker re-validates every
   attempt the previous process left (restart budget, kept directories, no leftover process or container of the old
   run — identity-checked, fail closed —, worktree linkage, trusted git metadata unchanged, last checkpoint intact) and
   lists it in HEARTBEAT `recoverableJobs`. The master parks it (RUNNING/STARTING `pause_confirmed` fenced by the
   epoch, or LOST `reconcile_pause`; pause cause `worker_restart`) **before** the LOST reconciliation runs, and resumes
   the same attempt on the same worker under epoch + 1 (`execution.resume{cause: "worker_restart"}`). A graceful stop
   parks running attempts the same way. F1 holds: the old epoch is never run again; a resume needs the master's new
   lease. A crash of the resumed run is recovered again from the record rewritten (fsynced) under the new epoch, up to
   `maxRestarts` (default 2).
3. **Half-finished tool calls are classified, not re-run blindly.** Every tool call is classified (`idempotent`,
   `workspace_write`, `external`, `unknown`). In-flight `external` / `unknown` calls are surfaced to the agent as
   "unknown outcome — verify before retrying"; approvals are asked again (the stopped run's pending requests are
   cancelled). The classes are on the timeline, in the audit and on the job page.
4. **Truthful native resume.** A runtime version continues its own session after a restart only when listed in
   `NATIVE_RESUME_VERIFIED` after the opt-in live test; otherwise a fresh session gets a continuation prompt built from
   the checkpoint (task, transcript tail, last tool calls, diff since the base and since the checkpoint, TODOs).

## Alternatives considered
- **Re-run the attempt from scratch after every restart.** Rejected: loses hours of work and repeats side effects;
  exactly the reported problem.
- **Keep the runtime process alive across a daemon restart (re-attach).** Rejected: not supported by the pinned runtimes'
  stdio protocols, impossible across reboots, and an orphan the daemon cannot supervise violates ADR-0012 rule 4.
- **Checkpoint by committing on the attempt branch.** Rejected: the attempt branch is what gets verified and pushed
  (ADR-0004 trailers); WIP commits would leak into the published history and the trusted-git snapshot would change.
- **Push checkpoints to the remote.** Rejected by default: remote side effects and secret exposure; local refs are
  enough for a same-machine resume.
- **Let the runtime re-run every interrupted call.** Rejected: duplicates pushes, deploys and package publishes.
- **Resume natively whenever the adapter has `resume()`.** Rejected (ADR-0008): unverified behaviour of a crashed
  session; only live-verified versions.

## Consequences
- Migration 0091 (`attempt_checkpoints`, `job_pauses.cause` + `worker_restart`, `job_pauses.restart`); master env
  `JOB_CHECKPOINT_INTERVAL_SEC` (0 = off), `JOB_CHECKPOINT_MAX_MB`, `JOB_CHECKPOINT_MAX_FILES`, `JOB_CHECKPOINT_KEEP`,
  `JOB_RESTART_MAX_RESUMES`. Master first, then a worker release (`session-continuity-v1`).
- Worker disk: checkpoint objects in the repository mirror (bounded, dropped with the attempt) and one snapshot copy per
  running workspace job.
- The chaos invariant "runtime started twice" now counts per lease epoch (a resume under a new epoch starts it again).
- Agents may be told an action's outcome is unknown; a careless agent can still repeat it — approvals keep gating the
  sensitive ones.

## Verification
Protocol, adapter, worker (real git, crash / graceful / integrity failure / double crash), master integration (resume
preferred over retry, fencing) and chaos (SIGKILL of a worker process mid-job → restart → completes once) tests; see the
design note §9. UNVERIFIED live: a restart of the Windows worker during a real Claude Code job, and native resume of
Claude Code / Codex (live tests pending).
