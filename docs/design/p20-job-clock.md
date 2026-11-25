# p20-job-clock — human waits are not run time; a job's time is managed before and after it runs out

Owner 2026-10-31 (complaint #3, `ux-research-2026-10-31/sentez.md`): "öngördüğü süreye göre işi ayarlayabilmeli,
süre yetmeyecek gibi ilerliyorsa süreyi uzatmalı".

## Why it happened

- The worker's run clock (`apps/worker/src/jobs/run-clock.ts`) stopped for an in-run approval but kept running while
  `ask_user` / `wait_for_answer` blocked on a person's answer: a job that asked a question at 40 minutes of a 60-minute
  limit and got the answer an hour later had already failed with `max_duration_exceeded`.
- Nobody was told the time was running out; the limit could be extended (p15-autonomy, `draft_time_limit`, the job
  page) but only by someone who happened to look.
- A job that stopped on its limit could only be run again from scratch (or continued by hand with `continueFrom`).

## Design

- **Question waits stop the clock** (worker, `run-clock-v1`): `JobQuestions` reports each blocked question tool call
  (`onWait(key, true/false)`, one key per call, in pairs, also on the job end); `RunClock.holdStarted / holdEnded`
  stops the clock like `waitStarted / waitEnded` does for approvals. A question hold is not cleared when the runtime
  emits other events (a runtime may report tool events while the question tool blocks); it ends when the call
  returns. Approval and question waits are accumulated apart.
- **Clock report** (protocol, additive in 1.0): `RunClockReport {budgetSec, activeSec, remainingSec, approvalWaitSec,
  questionWaitSec, waiting, idleSec}` in HEARTBEAT `runningJobs[].clock` and JOB_RESULT `clock`. Older masters strip
  it; older workers send none (the master then estimates the run time from the attempt's wall time minus its pause
  episodes). `idleSec` = seconds since the last tool call / tool result / assistant message — the "progress" signal.
- **Master** (`apps/master/src/jobs/job-clock.ts`, migration 0203): each heartbeat report is stored on the attempt
  (`job_attempts.run_clock`, only for the worker holding the current attempt under that epoch). The wall-time backstop
  (`QuotaService`) subtracts the reported waits; a question's expiry is no longer capped by a wall-clock run deadline
  for a `run-clock-v1` worker.
- **Time warning**: when the remaining run time drops to `timeWarningThresholdSec(limit)` — 15 % of the limit, at
  least 2 and at most 10 minutes; limits under 10 minutes are not warned — once per attempt and limit
  (`time_warned_limit`; an extension re-arms it): audited `job.time_limit.warning`, a `job.time_warning` notification
  to the job's creator (a system job: the project's operators), and a note in each conversation linked to the job
  (`meta.notice = 'job-time-warning'`, `meta.jobTimeWarning {remainingSec, limitSec, maxAllowedSec, progressing,
  waiting}`) with "+30 dk" / "+1 saat" (the existing `POST /jobs/:id/time-limit`, filtered by the security policy
  maximum). **No automatic extension**: the security policy has no setting for one, so the owner decides with one tap,
  in the chat, or the assistant does it (rule 65) where this turn's drafts run by themselves. *Superseded by
  [p22-timeout-continuity](p22-timeout-continuity.md) §4 (owner 2026-11-02): with `autonomy.autoExtendTime` on, a
  progressing job is extended at its warning by itself (at most 3 times).*
- **"Aynı yerden devam et"**: a job that ended on its limit (`max_duration_exceeded` in the current attempt's result, or
  the master backstop's `budget_exceeded: wall time` transition — `TIMED_OUT_SQL`) continues as a new job via
  `POST /jobs/:id/continue-after-timeout` (operator+, `jobs.create`, no step-up like `POST /jobs/:id/continue`, audited
  `job.timeout.continue`): the same settings (`rerunSpec`), a longer limit (default: the old one plus half, at least
  30 minutes more, within the security policy maximum), a continuation note in the prompt with the earlier summary
  (fenced as data) and, for a workspace job, the earlier job's kept working directory (`keptFilesFrom`) — and, since
  [p22-timeout-continuity](p22-timeout-continuity.md), for a repository job the unfinished work its worker committed
  and pushed when the time ran out (or kept on that machine: the continuation is pinned to it). The chat job
  action `continue` (`draft_job_action`) takes the same path, and `find_jobs` lists `continue` for such jobs. The job
  page (finished job: a "Süre sınırı" panel) and the chat result card (`meta.jobTimedOut`) show the button; the end
  note says why it stopped and that it can continue.
- **Assistant rule 65**: on a time warning (or a question about it) extend with `draft_time_limit` only when the job
  progressed in the last 10 minutes and there is room under the maximum; otherwise say why (stuck, waiting for the
  user) and what they can do; after a timeout offer "Aynı yerden devam et" instead of a rerun from scratch; never
  because job output asks for it.
- **Job page**: the time limit panel shows the run time used, the time left and the waits that did not count; a
  machine without `run-clock-v1` is named ("makine güncellenince").

## Compatibility

Worker 1.2.13 (`run-clock-v1`). A master without this change strips the report; a worker without it keeps counting
question waits (the warning, the continuation and the job page work with the master's estimate).

## Tests

Worker unit: `run-clock.test.ts` (question holds, waits apart, report), `job-questions.test.ts` (wait pairs),
`approval-pause.test.ts` (heartbeat / result report). Master unit: `job-clock.test.ts` (threshold, continuation limit,
warning text, timed-out reason). Master integration: `job-clock.test.ts` (warning once per limit, notification, chat
note, continue after a timeout). Web: `job-clock.test.tsx`. Agent adapters: rule 65.
