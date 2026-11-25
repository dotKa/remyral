# p11-session-continuity — a running attempt survives a worker restart

- **Task:** `p11-session-continuity`. **Date:** 2026-10-19.
- **Feedback addressed (P1):** "Agents can lose context and progress in long runs. Resuming only from a task summary
  isn't enough. Especially when a worker restarts: session recovery, workspace integrity, and half-finished tool
  calls."
- **Decision:** [ADR-0042](../adr/0042-session-continuity-across-worker-restarts.md).
- **Builds on:** [p10-approval-pause](p10-approval-pause.md) (PAUSED, parked records, same-attempt resume under a new
  epoch, workspace reopen + trusted-git check, continuation prompts), [p11-usage-limit-fallback](p11-usage-limit-fallback.md)
  (pause causes, resume multiplexer), [p11-master-resilience](p11-master-resilience.md) (offline lease grace / hold),
  [p4-orchestration](p4-orchestration.md) and [p4-chaos](p4-chaos.md) (F1: never run one attempt twice).
- **Migration:** 0091 (0090 / 0092 / 0093 = parallel p11 work). **Worker release:** yes (`session-continuity-v1`).
  **Protocol:** additive in 1.0.

## 1. What happened before (verified 2026-10-19)

| Piece | Behaviour | Where |
| --- | --- | --- |
| Worker restart mid-job | The new process drops every lease restored from disk, remembers the attempt as "already run" (no replayed ASSIGN_JOB reruns it) and never runs it again (F1, p4-chaos). | `apps/worker/src/jobs/runner.ts` `onSessionEstablished` |
| Master | The lease expires (or its offline hold ends) → LOST → `reconcileLost`: the attempt is resumed only when the reconnected worker still *runs* it; else retry from scratch when verifiably safe (runtime never started / attempt branch absent on the remote) or "needs human review". | `orchestrator.ts` `reconcileLost` / `#retryOrFail` |
| What survives | `continueFrom` copies artifacts only. The worktree stayed on disk orphaned. | — |
| Runtime resume | `resume()` / `resumeParked()` exist for all four runtimes, used only by the approval pause (ADR-0036) and the usage-limit park (ADR-0040). Claude Code / Codex `resume` is `unverified`, so those resumes continue in a fresh session with a continuation prompt (transcript tail + decision). | adapters, `resume.ts` |
| Half-finished tool calls | Re-run by the runtime after a resume; only approvals are answered from a matching fingerprint. Nothing distinguished a re-runnable read from a `git push` that may already have happened. | — |
| Master outage | ADR-0039: jobs survive 15 min without the master. A *worker* restart still lost the job. | — |

## 2. Shape

```
 running attempt (execution.continuity) ──────────────────────────────────────────────────────────────────────────
   before the runtime starts: continuity record <root>/.remyral/continuity/<job>.json (fsynced) — attempt, epoch,
     paths, trusted-git snapshot, restarts, policy; every runtime pid is added at once (fsynced)
   every intervalSec (default 120 s), when something changed and within the caps:
     repo: git add -A into a worker-owned index → write-tree → commit-tree (parent: previous checkpoint / base)
           → update-ref refs/remana/checkpoints/<attempt>/<n>      (never the work branch, never pushed)
     workspace job: manifest (path,size,mtime) + reflink/copy of the scratch dir (newest copy only)
     + runtime session pointer (adapter.sessionCheckpoint), recent tool calls with their class, activeMs
     → record updated (fsynced) → CHECKPOINT_REPORT to the master (metadata only; fenced by the live lease)

 worker stops gracefully (update, service restart) ──▶ the attempt is parked (cause worker_restart): runtime
     cancelled + parkSession, workspace / sandbox dir / session kept, nothing reported (the lease stays held)
 worker crashes (SIGKILL, power loss, BSOD) ──▶ the continuity record stays as last written

 restarted worker, before its first HEARTBEAT (recoverAfterRestart):
   for every continuity record / worker_restart parked record of an attempt not running here:
     restart budget (restarts < maxRestarts)          → else problem
     kept dirs are real directories inside the root    → else problem
     processes of the old run: same boot + pid alive + start time matches → kill tree; unverifiable → problem
     container profile, same boot → remove the attempt's containers (labels) → else problem
     repo: reopen worktree (.git → mirror, branch exists), assertTrustedGitUnchanged, last checkpoint ref intact
           → diff --stat since the checkpoint and since the base
     workspace job: manifest diff since the last snapshot
   ok → parked record (cause worker_restart, restart facts, mode session only if native resume verified)
   HEARTBEAT.recoverableJobs = [{job, attempt, epoch, checkpoint, at, activeMs, resume, restarts,
                                 unknownOutcome[], problem?}]

 master tick, step "worker-restart" (before LOST reconciliation):
   entry of a connected worker, job's current attempt, lease epoch == entry.epoch, worker == attempt's worker,
   worker advertises session-continuity-v1, no open pause:
     RUNNING/STARTING --pause_confirmed (worker actor, fenced by the epoch)--> PAUSED   or
     LOST --reconcile_pause--> PAUSED
     job_pauses(cause worker_restart, status resuming, resume_at now, restart facts), pending in-run approvals of the
     stopped run cancelled (the resumed runtime asks again), job_runs.recovery, audit job.continuity.restart_detected
     timeline: "Worker restarted — resuming from checkpoint 7 (2 min ago); 1 tool call(s) in flight with unknown
     outcome (Bash) — the agent verifies before retrying"
   entry with problem → audit job.continuity.not_resumable + job_runs.recovery; the classic reconciliation decides
 step "resume-paused": PAUSED --resume_paused--> RESERVED (same attempt, epoch + 1, same worker only),
   ASSIGN_JOB{execution.resume{cause: worker_restart, pausedEpoch, checkpoint, activeMs, restart}, continuity}
 worker: parked record must match (cause, attempt, paused epoch) → reopen → trusted-git check → continuity record
   rewritten under the new epoch with restarts + 1 (fsynced: the double-crash marker) → native resume (verified
   versions only) or a fresh session with the original prompt + earlier progress + the restart note
```

## 3. Protocol (additive in 1.0)

- Feature `session-continuity-v1` (`WorkerFeatureList` max raised to 64: several parallel p11 tasks add features).
- ASSIGN_JOB `execution.continuity: ContinuityPolicy` — `intervalSec` (15–3600), `maxBytes`, `maxFiles`, `keep`
  (1–50), `maxRestarts` (0–5). Sent only to workers with the feature; its presence is what enables checkpoints and
  restart recovery for that attempt (an older master never sends it → the worker behaves as before).
- `CHECKPOINT_REPORT` (control job message, seq 0): `{attemptId, epoch, n, at, kind: git|snapshot, ref?, commit?,
  files, bytes, runtimeSessionId?, lastTool?, inFlight, activeMs}` — no file names, no content. A lost report costs
  nothing: the worker's own record is authoritative.
- HEARTBEAT `recoverableJobs?: RecoverableJob[]` (≤ 64).
- `AssignedResume` gains `WorkerRestartResume {cause: "worker_restart", pausedEpoch, checkpoint, activeMs, restart}`.
- `classifyToolCall(toolName, inputSummary) → idempotent | workspace_write | external | unknown` (shared by worker,
  master and web).

## 4. Tool-call classes (half-finished calls)

| Class | Examples | After a restart |
| --- | --- | --- |
| `idempotent` | Read / Grep / Glob / LS / list / WebFetch / WebSearch / TodoWrite, `wait_subtask`, shell `ls`, `cat`, `git status/diff/log/show` | redo if needed |
| `workspace_write` | Edit / Write / MultiEdit / NotebookEdit / `apply_patch` | redo from the workspace as it is (the checkpoint / diff is in the note) |
| `external` | shell `git push`, `gh pr/release`, `npm publish`, package installs (`npm/pnpm/pip/cargo/brew/apt … install`), `docker push/run`, `kubectl`, `terraform`, `vercel`, `wrangler`, cloud CLIs, `ssh/scp/rsync`, `curl -X POST/-d`, `sudo`, deploy/publish scripts; `request_subtask`, `cancel_subtask`, `publish_site`, preview tools, machine-admin tools, unknown MCP tools | **never re-run silently** |
| `unknown` | anything else (`pnpm test`, `node script.js`, a redirect `>`) | treated like `external` |

A call is *in flight* when its `tool_call` has no `tool_result`. In the continuation the agent gets, fenced as data:
`external` / `unknown` in-flight calls under "OUTCOME IS UNKNOWN — verify (remote branch, deployment, package) before
retrying"; `idempotent` / `workspace_write` ones as "interrupted, can be redone"; the last completed calls; the diff
since the base and since the last checkpoint; its last TODO list. Calls that need an approval ask again (the stopped
run's pending requests are cancelled at restart detection; nothing is carried over — fail closed). The classes are
recorded on the timeline (pause_confirmed reason), in the audit (`unknownOutcome: ["Bash:external"]`), in the
checkpoint reports and on the job page.

## 5. Worker

| Piece | Where |
| --- | --- |
| Continuity record / store, tool tracker, git checkpoints on hidden refs, snapshots, `AttemptContinuity` | `apps/worker/src/jobs/continuity.ts` |
| Leftover processes of a crashed run (boot time, pid start time, tree kill) | `apps/worker/src/jobs/leftovers.ts` |
| Containers of a crashed run (labels `remyral.job` + `remyral.attempt`) | `ContainerSandboxRunner.removeAttemptContainers` |
| Recovery before the first heartbeat, graceful-stop parking, resume, `checkpointNow` | `apps/worker/src/jobs/runner.ts` |
| Restart note (unknown outcome, diff, TODOs) | `apps/worker/src/jobs/resume.ts` `restartNote` |
| Parked record `cause: worker_restart` + `restart` facts | `apps/worker/src/jobs/parked.ts` |
| `GIT_INDEX_FILE` support (worker-owned index) | `apps/worker/src/workspace/git.ts` |
| HEARTBEAT `recoverableJobs`, CHECKPOINT_REPORT | `apps/worker/src/daemon/daemon.ts` |

- **F1 kept.** The restored lease is still dropped and the attempt remembered in `#seen` (a replayed ASSIGN_JOB of the
  old epoch is never run). The attempt runs again only under a **new epoch** the master granted after parking it, on
  this worker, after the leftovers check — so it never runs twice concurrently. The master re-checks job, attempt,
  lease epoch and worker under the job's row lock (fencing).
- **Double crash.** The resumed run rewrites the continuity record (new epoch, `restarts + 1`, fsynced) *before* its
  runtime starts; a second crash is recovered from that record (the master's lease is now the new epoch) until
  `restarts ≥ maxRestarts` (default 2), then it is reported with a problem and the classic reconciliation decides. A
  record older than a parked record of the same attempt yields to it, a newer one wins.
- **Graceful stop** (`JobRunner.stop`): attempts with checkpoints whose runtime started are parked (`worker_restart`)
  instead of dropped; nothing is reported. Self-fenced attempts (lease lost) are never parked.
- **Checkpoint cost.** `git add -A` into a persistent worker-owned index (`.remyral/continuity/<job>.<attempt>.index`)
  re-hashes only changed files; unchanged trees are skipped; the changed-file size is measured first (`ls-files -m -o`)
  and a checkpoint over the caps is skipped (logged). The worktree's own index, HEAD and branch are never touched; the
  trusted-git snapshot (T-SBX-4) is unaffected (checkpoint refs are not part of it).
- **Cleanup.** A finished attempt removes its record, hidden refs, index and snapshots; a parked one keeps refs for its
  resume; a discarded parked attempt (cancel / restart from scratch / retention) drops its refs too.

## 6. Master

| Piece | Where |
| --- | --- |
| Checkpoint storage (fenced), restart detection + parking, resume preparation, retention (1 day), view | `apps/master/src/continuity/service.ts` |
| `GET /jobs/:id/continuity` (jobs.read) | `apps/master/src/continuity/routes.ts` |
| HEARTBEAT `recoverableJobs`, CHECKPOINT_REPORT routing | `apps/master/src/orchestration/session.ts` |
| Tick step `worker-restart` (before `lost`), `execution.continuity`, resume reason | `apps/master/src/orchestration/orchestrator.ts` |
| Resume multiplexer (worker restart first), service wiring, `JOB_CHECKPOINT_*` env | `compose.ts`, `config.ts` |
| Migration | `0091_session_continuity.sql`: `attempt_checkpoints`; `job_pauses.cause` + `worker_restart`, `restart` jsonb |

**Reconcile prefers resume.** The `worker-restart` step runs right after the lease sweep and before the LOST
reconciliation, so a worker that reconnects with a resumable attempt is parked and resumed whether its lease is still
live (restart within 90 s or within the ADR-0039 offline hold — no LOST at all) or already LOST (then `reconcile_pause`
instead of `reconcile_retry` / `reconcile_fail`). A resume decline (`paused_workspace_missing`, permanent) blocks the
episode (Restart from scratch / Cancel); the generic `lapsedResume` and orphan handling of p10 apply unchanged.

**Configuration** (master env): `JOB_CHECKPOINT_INTERVAL_SEC` (120; 0 = off), `JOB_CHECKPOINT_MAX_MB` (512),
`JOB_CHECKPOINT_MAX_FILES` (50 000), `JOB_CHECKPOINT_KEEP` (10), `JOB_RESTART_MAX_RESUMES` (2).

## 7. Console

- Job page card **Session continuity**: resume history ("Worker restarted — resuming from checkpoint 7 (2 min ago)",
  status, epoch 1 → 2, session vs fresh continuation, "Unknown outcome — the agent was told to verify before retrying:
  Bash (external effect)"), checkpoints of the current attempt (#, time, files / size, last tool and its class, calls
  in flight). Polls every 15 s while the job runs.
- Pause panel: "The worker restarted — resuming the same attempt on DESKTOP…" (no decision needed; Restart from scratch
  / Cancel as for any pause).
- Timeline: the `pause_confirmed` / `reconcile_pause` and `resume_paused` reasons above.

## 8. Native resume verification

`packages/agent-adapters/src/resume-verification.ts`: `NATIVE_RESUME_VERIFIED` lists runtime **versions** whose native
resume after a restart passed the live test; for those the adapter's `resume` capability becomes `supported` and the
worker records `mode: session` (the runtime continues its own session). Empty today: Claude Code 2.1.296 and codex-cli
0.162.1 are **UNVERIFIED** → production continues in a fresh session with the continuation prompt. The opt-in live tests
(`REMYRAL_LIVE_RUNTIMES=1`) — `test/runtimes/claude-code/resume-live.test.ts` (Agent SDK `options.resume`) and
`test/runtimes/codex/resume-live.test.ts` (`thread/resume`) — run a turn, record `sessionCheckpoint` while it runs,
abandon the adapter without parking (a crash), and continue it from a new adapter instance on the same state dir; on
success they print the entry to add. A version bump falls back to unverified by itself. New adapter method:
`sessionCheckpoint(ref)` (read only; Claude Code, Codex, fake).

## 9. Tests

- Protocol: tool classes (26 cases), policy bounds, CHECKPOINT_REPORT (hidden refs only), HEARTBEAT `recoverableJobs`,
  the `worker_restart` resume — `packages/protocol/test/continuity.test.ts`.
- Adapters: verification registry, capability gating, fake `sessionCheckpoint` — `test/resume-verification.test.ts`;
  live (skipped by default) `test/runtimes/{claude-code,codex}/resume-live.test.ts`.
- Worker — `apps/worker/test/session-continuity.test.ts`: tool tracking + restart note (fenced data, unknown outcome);
  real-git checkpoints on hidden refs (work branch / HEAD / index untouched, unchanged skipped, over the caps skipped,
  refs dropped); snapshots + diff; leftover processes (reboot, our pid killed, reused pid ignored, unverifiable → fail
  closed); **crash mid-run → restarted runner validates the checkpoint, reports it, resumes on `worker_restart`, the
  in-flight `git push` is surfaced as unknown outcome, the replayed epoch-1 ASSIGN_JOB is not run**; graceful stop →
  parked → resumed; **integrity failure** (trusted git metadata changed while down) → problem + resume declined;
  **double crash** (resume marker under the new epoch, then the restart budget ends it).
- Master integration (real Postgres, real worker daemon over WebSocket restarted on the same data dir) —
  `apps/master/test/integration/session-continuity.test.ts`: checkpoints listed; restart mid-run → PAUSED
  (`worker_restart`) → same attempt resumed under epoch 2 → SUCCEEDED, one attempt, no `reconcile_retry/fail`, timeline
  and audit; **fencing**: other epoch / attempt / worker ignored, a problem entry moves nothing, a stale checkpoint is not
  stored.
- Chaos — `apps/master/test/chaos/session-continuity.chaos.ts` (`pnpm chaos`): the worker **process is SIGKILLed** mid-job
  and started again on the same disk → resumed, AWAITING_APPROVAL after verification, one attempt, one commit, the runtime
  started once per epoch, all invariants (the "runtime started twice" invariant now counts per lease epoch).
- Web: `apps/web/test/session-continuity.test.tsx`.

## 10. Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| The same attempt runs twice (old orphan + resumed run) | Resume only under a new epoch granted after parking (fenced under the job row lock); leftover processes killed only after their identity (boot, pid start time) is confirmed; unverifiable → not resumed; containers removed by attempt labels; replayed old-epoch ASSIGN_JOB never runs. | A process that left the attempt's process group *and* was reparented (POSIX setsid escape) is contained only by the sandbox (as before). |
| A tampered workspace is resumed (T-SBX-4) | Kept paths re-validated (real dirs inside the root), worktree `.git` must point into the mirror, trusted-git snapshot compared, the last checkpoint ref must still name the recorded commit; any failure → not resumed (classic reconciliation). | Files of the worktree itself are agent-writable, as during a run. |
| Checkpoints leak or get published | Hidden refs `refs/remana/checkpoints/…` live only in the worker's mirror; the publish step pushes exactly `refs/heads/rac/<job>/<attempt>`; the report carries counts only; refs are dropped when the attempt ends. Objects stay until the mirror is pruned (same trust as the worktree). | — |
| A side effect repeated after a restart (double push / deploy / payment) | In-flight `external` / `unknown` calls are never re-run by the platform; the agent is told the outcome is unknown and to verify first; approvals are asked again (pending ones cancelled; no carry-over). The attempt branch push itself keeps its force-with-lease + trailer checks. | An agent may still ignore the note; approvals gate the sensitive actions as before. |
| Untrusted text in the continuation prompt | Tool summaries, diffs, TODOs are bounded, neutralised (no fence breaking, no control characters) and fenced as data (ADR-0010). | — |
| Crash loop | `maxRestarts` (default 2) per attempt; then the classic reconciliation. Restart episodes expire after a day. | — |
| Repudiation | Audit `job.continuity.restart_detected` / `not_resumable` / `resume_blocked`, `approval.cancel` for the cancelled requests; transitions in the append-only history. | — |

## 11. Rollout, rollback, operations

- Deploy the master first (migration 0091; it accepts `CHECKPOINT_REPORT` / `recoverableJobs` and sends
  `execution.continuity` only to workers advertising `session-continuity-v1`), then release the worker. An older
  worker: nothing changes. An older master: never sends `execution.continuity` → no checkpoints, no recovery.
- Rollback: master code can roll back after 0091 (additive table / column / enum-like check value; a job PAUSED by a
  worker restart would not be resumed by older code — resume or cancel those first). `JOB_CHECKPOINT_INTERVAL_SEC=0`
  turns it off without a rollback.
- Disk: hidden-ref objects in the repository mirror (bounded by `keep` refs per attempt and dropped with the attempt)
  and, for workspace jobs, one snapshot copy per running attempt under `<root>/.remyral/continuity/snap/`.
- Ops: worker logs `checkpoint taken`, `attempt left by the previous worker process is resumable` / `cannot be
  resumed`, `stopped processes the crashed run left behind`; master log `worker restarted; attempt parked for a resume`.

## 12. UNVERIFIED (needs real machines / runtimes)

- A real Windows worker (win-1) restarted during a Claude Code job (service restart and a hard kill of
  `node.exe`): the job page must show "Worker restarted — resuming from checkpoint N", the job finishes once on the same
  machine; check the Windows leftover check (`Get-Process … StartTime`) and the per-job-account (`remyral-job-N`)
  process tree kill. Steps in the task report / `docs/guide/tr/oturum-surekliligi.md`.
- Native resume of Claude Code / Codex after a crash (live tests above); until then fresh-session continuation.
- Container-profile recovery on Linux (container removal by labels) — unit-tested only.
