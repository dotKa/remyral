# p22-timeout-continuity — a job that runs out of time keeps its work, continues from it, and is extended while it progresses

Status: implemented (2026-11-02). Migration 0215. **Worker release needed** (`timeout-delivery-v1`). Protocol additive in
1.0. Builds on [p20-job-clock](p20-job-clock.md), [p11-session-continuity](p11-session-continuity.md),
[p4-git-flow](p4-git-flow.md), [p15-autonomy](p15-autonomy.md) (ADR-0056) and
[p20-outcome-contract](p20-outcome-contract.md).

## 1. Evidence (test server, 2026-11-01, project sample-site)

- A repository job (Claude Code, worker ip-10-0-0-12, limit 3600 s). The agent had finished — lint and
  types clean, 313 unit + 122 DB tests, production build, browser flow — and wrote its final summary at 22:40. At
  22:41:03 the **master backstop** cancelled it (`cancel_requested` "budget_exceeded: wall time 3601 s reached the job
  limit 3600 s", then CANCELLED "run stopped (failed)") while the worker's own clock still had 16 s. Nothing was
  committed or pushed.
- The worker had 26 git checkpoints (`refs/remana/checkpoints/<attempt>/<n>`, the last with 124 files) — never pushed,
  and dropped when the attempt ended.
- A time warning went out at 22:32; nobody extended. The owner, 2026-11-02: "istediğin zaman işlerin süresini
  uzatabilirsin".
- The assistant started a NEW job that landed on another machine; `continueAfterTimeout` told the model "the
  earlier changes were not published: redo only what is needed". The owner: "önceki makinedekileri main e merge edip
  devam ettir. niye böyle yapıyorsun."
- The chat card showed "İptal edildi" with "failed" under it.

## 2. Keep the work on a time limit (worker, `timeout-delivery-v1`)

`apps/worker/src/jobs/timeout-delivery.ts`, wired in `JobRunner.#run` (repository jobs under git flow only —
`execution.pushResult`, never a pinned pull request head, ADR-0026).

A run stops on its time limit when the run clock expires (`max_duration_exceeded`) or the master backstop's CANCEL_JOB
reason starts with `budget_exceeded: wall time` (`isTimeLimitStop`). Then, in the attempt's `finally` and before the
workspace is released or parked:

1. the runtime is stopped (the abort already asked; `adapter.cancel` once more, bounded 15 s);
2. `assertTrustedGitUnchanged` (T-SBX-4) — the same check the publish uses;
3. within **`TIMEOUT_DELIVERY_GRACE_SEC` = 120 s** (protocol constant): changed files are measured against the size
   caps (the job's continuity policy, default 50 000 files / 512 MiB); one work-in-progress commit `WIP: <title>` with
   the attempt trailer and the job's git identity (`WorkspaceManager.commit`, hooks never run), then the normal `push`
   — exactly `refs/heads/rac/<job>/<attempt>`, `--force-with-lease=<ref>:` (must not exist), pre-push secret scan with
   the job's exact secret values. Never the base branch; nothing merges it (AGENTS.md rule 10 unchanged).
4. JOB_RESULT `partial: {branch, commit, files, pushed: true}`; the summary says "Time limit reached before the run
   finished. The unfinished work (N file(s)) was committed and pushed to rac/… — not merged" plus the transcript tail
   (never a bare "failed").

Failure paths (the attempt still ends as a timeout — `max_duration_exceeded` / the backstop's cancel — so
`TIMED_OUT_SQL` is unchanged):

| What failed | Kept | `partial` |
| --- | --- | --- |
| push refused / network | the WIP commit under `refs/remana/kept/<attempt>` in the worker's mirror | `pushed: false, ref, reason: push_failed` |
| secret scan | same | `reason: secret_scan` |
| grace ran out (commit or push) | the WIP commit, or the last continuity checkpoint | `reason: grace_exceeded` |
| changes above the caps / commit failed | the last continuity checkpoint commit | `reason: too_large` / `commit_failed` |
| nothing changed since the base | — | absent |

`refs/remana/kept/*` survive the attempt (checkpoint refs and the local attempt branch are dropped with it); kept refs
older than 14 days are pruned when a new one is written in the same mirror. A paused, already-published or self-fenced
attempt never delivers (another epoch / worker may own the job).

### Backstop vs. the worker's clock

The worker's clock starts when the runtime starts (after the checkout), so its limit falls later than the attempt's wall
time — in production 16 s later. `QuotaService.checkWallTime` now waits `wallTimeGraceSec(features)` past the limit:
`TIMEOUT_DELIVERY_GRACE_SEC + BACKSTOP_SLACK_SEC` (120 + 300 s) for a worker that reports `run-clock-v1`, 0 for older
workers (as before). It stays the hard stop after that; its cancel also triggers the delivery on a
`timeout-delivery-v1` worker.

## 3. Continue from the kept work (master)

`JobClockService.continueAfterTimeout` (`POST /jobs/:id/continue-after-timeout`, chat `draft_job_action continue`):

- **pushed**: the remote attempt branch must still name the commit (`GitFlowService.providerFor → branchHead`; the
  worker's report is a claim). The new job: `repository.baseRef = <commit>`, `repository.targetBranch = <the original
  job's target>` and — in the create transaction (`withinCreate`) — a `job_git` row with the **original base at job
  start**. So the worktree starts with the earlier changes, verification checks "descends from the base" against the
  original base, the verified diff / PR / test merge cover everything, and the protected merge (unchanged: the person or
  the security policy decides) brings the earlier work in.
- **kept on one machine** (`pushed: false` with a ref): the same, plus `requirements.workers = [<that worker>]` — the
  commit exists only in that machine's mirror (`#resolveBase` reads `<sha>^{commit}` there).
- otherwise (nothing kept, an older worker, the branch is gone and no ref): from the base, as before.

The continuation note says "Your earlier changes are already in the working tree … (commit …, N file(s)). Check them
(git log / git diff against the base), finish what is missing and deliver — do not start over". The response and the
audit `job.timeout.continue` carry `from: pushed | machine | base` (and commit / branch / worker).

`keptWorkOf` (`apps/master/src/jobs/kept-work.ts`) reads `job_runs.result.partial` of the current attempt; it feeds
the time-limit view (`clock.keptWork`), the chat result note (`meta.jobKept`), `find_jobs` / `describe_job`
(`keptWork` with what "continue" does) and the end note's words.

The automatic fix job of p15-auto-mode (`AutoFixService`) skips a job stopped by its time limit (cause `timeout`): a
fix job would start over from the base on any machine — the very thing this note removes.

**Assistant** (worker release for the prompt): rule 65 — after a time limit ALWAYS `draft_job_action continue`, never
`run_again` or a new `draft_job`; never say the work is lost when `keptWork` exists. `draft_job_action` / `draft_time_limit`
/ `change_settings` descriptions updated (packages/protocol).

## 4. Automatic time extension (owner decision 2026-11-02)

Security policy `autonomy.autoExtendTime` ("Süreyi kendiliğinden uzat"; Serbest on, Dengeli on, Sıkı off — preset
values in code like every autonomy flag, so no document migration; Settings → Security switch, `change_settings`).

At the time warning (`JobClockService.#one`, once per attempt and limit) the job is extended when **all** hold:

- the switch is on (read at that moment);
- it progressed: `idleSec ≤ 600` (`PROGRESS_WINDOW_SEC`) and it waits for no approval / answer;
- there is room under `autonomy.maxJobMinutes`;
- fewer than **`AUTO_EXTEND_MAX_PER_JOB` = 3** automatic extensions so far (rows `via = 'auto'`).

The step is `continueLimitSec` (the limit plus half, at least 30 minutes, within the maximum).
`TimeLimitService.autoExtend` writes the change in the same path as a person's (dispatch lock, row lock, the signed
SET_TIME_LIMIT to a `time-limit-v1` worker), refuses when the limit changed meanwhile, audits
`job.time_limit.auto_extend` (system actor `job-clock`; from / to / n / max / delivery), and each linked conversation
gets "**Süreyi otomatik uzattım: +X dk** — … yeni süre sınırı Y dk (n/3)" (`meta.notice = 'job-time-extended'`). The
warning notification is not sent then; a stuck job (no progress / unknown), a waiting job, the cap or the switch off →
the warning as before. The extension re-arms the warning for the new limit.

The assistant may extend a progressing job at once (`draft_time_limit`, execute) — in a user turn as before, and with
the switch on also in a watch follow-up turn (`directDecision`).

Migration **0215**: `job_time_limit_changes.via` accepts `'auto'`.

## 5. Result card and job page

- Chat card (`JobResultCard`, `meta.jobTimedOut` + `meta.jobKept`): a job stopped by its limit is **"Süre doldu"**
  (not "Başarısız" / "İptal edildi", no raw summary such as "failed", no "Düzelt"), the kept-work line ("Yapılan iş
  kaybolmadı: 124 dosyalık değişiklik rac/… dalına gönderildi (birleştirilmedi)" / "yalnızca <makine> makinesinde
  saklanıyor") and "Aynı yerden devam et" up front ("Yeniden çalıştır" moves under the details).
- Job page (`JobClockEndPanel`): "Süre doldu · …", the same kept-work line and the continue button.
- Strings: `timeLimits.clock.expired / keptPushed / keptLocal / nothingKept / autoChange`, `assistantAdmin.settings.
  autoExtendTime(Hint)` (TR + EN).

## 6. Security review

| Threat | Mitigation |
| --- | --- |
| Unfinished work merged without a decision | It goes only to the attempt branch; the continuation's merge is the normal protected merge decision (ADR-0056 policy). |
| A secret in the unfinished work is published | Same pre-push secret scan (pattern rules + exact secret values); a refusal keeps it local only (same trust as the worktree) and says so. |
| A tampered workspace is committed (T-SBX-4) | `assertTrustedGitUnchanged` before the commit, as the publish. |
| A forged `partial` makes the continuation start from a foreign commit | A pushed claim counts only when the remote attempt branch names it; a local one is used only on the machine that reported it, from its own mirror; the original base at job start stays the verification base, so the verified diff shows everything that would merge. |
| Endless jobs through automatic extension | Off in Sıkı; only while progressing; ≤ 3 per job; never above `maxJobMinutes`; every extension audited and announced. |
| Backstop disabled by a worker | The grace is fixed (7 min) and only for `run-clock-v1` workers; the backstop stays the hard stop. |

## 7. Rollout and rollback

Master first (migration 0215; additive), then the worker release. An older worker: no `partial`, the continuation
starts from the base as before (the backstop grace applies to any `run-clock-v1` worker — 1.2.13+). Rollback: master
code can roll back after 0215 (an older master ignores `partial` and `via = 'auto'` rows read as ordinary changes);
the switch off = no automatic extension. Ops: worker log `time limit: unfinished work pushed to the attempt branch` /
`… kept on this machine`; audit `job.time_limit.auto_extend`, `job.timeout.continue` (`from`).

## 8. Tests

- Worker `apps/worker/test/timeout-delivery.test.ts` (real git, temp bare remote): run clock → WIP commit with the
  trailer pushed to the attempt branch, main untouched, summary; backstop cancel → same (outcome cancelled); an
  ordinary cancel / no git flow / no change → nothing; push refused → `refs/remana/kept/<attempt>`; secret scan; grace
  exceeded; above the caps → the checkpoint.
- Master unit `test/unit/timeout-continuity.test.ts`: backstop grace, `partial` schema, policy presets / patch, note
  text, end-note words, `keptWorkLine`, follow-up direct decision.
- Master integration `test/integration/timeout-continuity.test.ts` (real worker, plain-git provider): timeout → pushed
  partial → continuation from it (baseRef, target, original base, note, audit) → verified changes hold both runs'
  files; local-only → pinned to the machine; unconfirmed claim → from the base. `test/integration/auto-mode.test.ts`: a
  timed-out job gets no auto-fix job. `test/integration/job-clock.test.ts`:
  backstop waits limit + grace + slack for a run-clock worker (policy off: warning, no extension); auto-extend audited
  without the warning notification; the cap of 3; no extension without progress.
- Web: `chat-job-result.test.tsx` (Süre doldu, kept work, continue; machine-only), `job-clock.test.tsx` (job page).
- Agent adapters: rule 65.

## 9. UNVERIFIED

- A real Claude Code run on a Windows / Linux worker stopped by its limit (the adapter's stop before the commit on
  Windows per-job accounts) — run a 10-minute job with `maxDurationSec: 600` that keeps working, check the attempt
  branch, then "Aynı yerden devam et".
- A GitHub-hosted repository (the push uses the same JOB_CREDENTIAL path as the publish; the continuation reads the
  branch through the GitHub provider).
