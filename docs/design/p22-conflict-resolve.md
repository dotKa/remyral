# p22-conflict-resolve — a result that conflicts with its target is carried onto it, not redone

Owner 2026-11-03 (screenshot of the assistant): two `remana-lead-panel` jobs started from the same `main`; the first
(nonce signatures) merged, the second (UI/UX + WhatsApp filters, PR #7, 48 files) then conflicted in 4 files. The
"leave open" decision needed a person; the assistant threw the 25-minute result away, started the task again from
scratch ("a job cannot see the old branch and main at once") and told the owner to close PR #7 on GitHub.

## 1. What was missing

- A conflicting verified result only had "merge" (refused: `merge_conflicts`), "leave open" or reject. Nothing carried
  it onto the moved target.
- The assistant's claim was wrong for the machine: the cached clone fetches every branch, so the earlier attempt's head
  object is on the machine. What is true: the agent's own git dir is scratch (`apps/worker/src/sandbox/attempt-git.ts`)
  — its commits are ignored and the worker commits the working tree on top of the base. So the earlier result must be
  merged into the *working tree* of a job that starts from the current target, not committed on the old branch.
- Nothing closed a superseded pull request.

## 2. Change

**Conflict-resolution job** (`apps/master/src/self-heal/conflict-resolve.ts`, migration 0217
`job_conflict_resolutions`, one row per source job):

- Eligible source: verification passed, `merge_state = 'conflicts'`, not merged, a verified head; AWAITING_APPROVAL, or
  SUCCEEDED with its pull request left open. Never a platform report job (`isPlatformJob`) or a workflow step / sub-job
  (`partOfRun`): those reach the target through their run.
- The new job is the source's settings (`rerunSpec`) with `baseRef` = the target branch (normal base capture — the
  verified diff is then only the source's changes plus the resolution), title `Resolve conflicts: <title>`, and a
  prompt: `git merge --no-commit --no-ff <source head>` (fallbacks `git cherry-pick -n <base>..<head>` /
  `git diff <base> <head> | git apply -3`), resolve keeping both sides, finish the original task, run the checks, do
  not commit. The conflicting files and the commits the target gained are listed as fenced data.
- Started by a person: `POST /jobs/:id/resolve-conflicts` (operator+, `jobs.create`, audited `job.conflict_resolve`),
  the job page's **Çakışmayı çöz** (Otomatik işlemler panel) or the assistant's `draft_job_action resolve_conflicts`.
- In **Otomatik mod** the loop step `conflict-resolve` opens one per conflicting AWAITING_APPROVAL result (checked in
  the last 6 h, a job a person started), as that person (re-authorised), like the auto-fix job. A skipped source is
  remembered with its reason.

**Superseding** (`GitFlowService.supersede`): when the resolve job's result merges, the source's pending merge decision
is withdrawn (approval `cancelled`, merge request `cancelled`), a source still AWAITING_APPROVAL takes the existing
`cancel_requested` transition (system, reason names the resolving job; no new state-machine edge), and its pull request
is closed with a comment pointing at the resolving job — new optional provider method `closePullRequest` (GitHub: issue
comment + `PATCH pulls/{n} state: closed`; GitLab: note + `state_event: close`; Bitbucket: comment + decline; plain git:
absent, nothing to close). A close failure is only logged. A merge of the source that is approved or executing makes
the step wait (`busy`). A resolve job that ends without merging marks the row `failed`; the source is untouched and can
be resolved again.

**Visible**: `job_auto_events` kind `conflict_resolve` (created / merged / failed) on the job timeline;
`GET /jobs/:id/autonomy` gains `conflictResolve`, `conflictResolveOf`, `conflictResolvable`; `describe_job` gains
`git` (merge state, conflicting files) and `conflictResolve` / `resolvesConflictsOf`; the owners and the creator get the
"fix job finished" notification once.

**Assistant**: rule 70 and the `draft_job_action` description: a conflicting result is resolved with
`resolve_conflicts`, never redone with `run_again` / a fresh draft, and the user is never asked to close a pull request.

## 3. Limits

- The source head's objects must still be in the machine's cached clone (the attempt branch exists while its PR is
  open); otherwise the prompt's cherry-pick / diff fallbacks need the base, which is listed.
- `closePullRequest` is fixture-tested only (UNVERIFIED-LIVE) on all three hosted providers.
- Master only: no worker release.
