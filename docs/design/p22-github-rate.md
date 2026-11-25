# p22-github-rate — the merge-state refresh no longer exhausts the GitHub App's rate limit

Owner 2026-11-02, with the assistant's answer "Kodu hala okuyamıyorum … HTTP 403 ile reddediyor": "kritik bir sorun
aslında bu."

## 1. What happened (test server, 2026-11-02)

- From about 03:00, `gitflow` logged `GitHub GET answered HTTP 403` every few seconds: 492 `refresh failed` and 220
  `base capture failed` lines in one hour. The provider only prints that text for a **rate-limited** answer
  (`x-ratelimit-remaining: 0`), so the installation's hourly budget (5000 requests) was exhausted. The App, its key and
  its permissions were fine.
- 14 jobs were `AWAITING_APPROVAL` (verified, not merged). The loop re-checked **every one of them every 30 s, for as
  long as it waited**: ref of the attempt branch, ref of the target, a compare, the pull request, check-runs and commit
  statuses — 6 or more requests per check, about 10 000 requests an hour for 14 jobs. A CI state of `none` (no CI on
  the repository) never settles, so the CI reads were repeated too.
- The provider treated the rate limit as "transient" and the loop retried at the same pace, so the budget was used up
  again right after every reset.
- **Worse than "the assistant cannot read code":** two running jobs could not capture their base at job start. Without
  a base, verification refuses the result ("the base at job start was never captured") — new jobs would have failed
  at the end. The assistant's "iş başlatmayı engellemez" was right for the start, wrong for the finish.

## 2. Change

- **Installation budget** (`gitflow/github-rate.ts`): every GitHub answer's `x-ratelimit-*` headers are recorded per App
  and installation (shared by every project on it). A rate-limited answer — 429, 403 with `x-ratelimit-remaining: 0`,
  or a secondary limit's `retry-after` — **pauses** the installation until the reset GitHub names (at most an hour; 60 s
  without one). Requests in the pause fail at once without reaching GitHub, with a message that says so:
  `… not sent: the installation's API rate limit is exhausted until <time>` (the 403 line now says
  `API rate limit exhausted; requests paused until <time>`), so the assistant can name the reason.
- **Reserve for work that cannot wait:** the merge-state refresh of the loop is skipped while the remaining budget is
  below a fifth of the hourly limit (at least 200 requests) or paused — base capture, verification, merge approvals
  and merges keep finding budget. A forced refresh (merge request, merge) still goes. Other providers have no budget
  (`backgroundBudgetLow` is optional).
- **Older results are re-checked less often:** every interval (30 s) for the first 10 minutes after verification,
  every 2 minutes up to an hour, every 10 minutes up to a day, then every 30 minutes. The 14 jobs above now cost about
  500 requests an hour instead of 10 000.

No migration, no API change, no worker release.

## 3. Verification

- `apps/master/test/unit/p22-github-rate.test.ts`: the pause (reset header, `retry-after`, 429), another repository of
  the same installation paused too, resume after the reset, the reserve, a permission 403 pauses nothing.
- `apps/master/test/integration/p22-github-rate.test.ts`: the age-based refresh schedule on a real database; a low
  budget skips the background refresh without touching `merge_checked_at`; a forced refresh still runs.
- Live: after the deploy, the `gitflow` 403 lines stop once the current window resets, and the two running jobs
  capture their base.

## Changelog

- fix(master): **the merge-state refresh no longer exhausts the GitHub App's rate limit** (p22-github-rate,
  [design](p22-github-rate.md); owner 2026-11-02: "kritik bir sorun aslında bu"). Results waiting for
  approval were re-checked every 30 s forever (~10 000 requests/h for 14 jobs), so from 03:00 every GitHub call —
  the assistant's code reads, and the base capture new jobs need for verification — answered 403. Now a rate-limited
  installation pauses until GitHub's reset instead of being retried, background re-checks keep a fifth of the budget
  free for work that cannot wait, and older results are re-checked less often (30 s → 2 min → 10 min → 30 min).
