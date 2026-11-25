# p22-git-preflight — repository access preflight, base ref fallback, cached-clone self-heal

Status: implemented (master, worker, web, i18n; migration 0208). Owner request 2026-11-01.

## Evidence

Of 102 FAILED jobs in the 14 days to 2026-11-01 on the test server, about 45 were git / repository environment
failures (final transition reasons):

| Count | Reason | Cause |
| ---: | --- | --- |
| 12 | `git fetch failed (exit 128): fatal: could not read Username for 'https://github.com'` | the job got no credential for a private repository |
| 3 | `git push failed (exit 128): remote: Invalid username or token.` | the connection's token was refused |
| 3 | `git fetch failed (exit 128): fatal: detected dubious ownership in repository` | the cached clone is owned by another account (Windows per-job accounts, shared caches) |
| 5 | `git fetch failed (exit 1): fatal: bad object refs/heads/rac/<uuid>…` | a ref of the worker's cached clone points at a missing object |
| 8 | `BaseRefNotFoundError: base ref "main" was not found` | empty repository / default branch named differently |
| 4 | `BaseRefNotFoundError: base ref "agent/chat-<id>" was not found` | a chat work branch that no longer exists |
| 6 | `git log failed (killed): timed out or output limit exceeded.` | the pre-push secret scan walked the whole history |
| 4 | `head X is not a descendant of the base at job start Y` | diverged / behind attempt |

Goal: prevent them before a runtime starts, heal them automatically, or fail early with a reason the user can act on.

## §1 Repository access preflight (master, before dispatch)

`self-heal/repo-access.ts` (`RepoAccessPreflight`), called first in `SelfHealService.beforeDispatch` (outside the
dispatch lock, like base ref healing). It answers "can the worker read this repository with what the platform hands
it?" by following the credential paths of `gitflow/credentials.ts` / `git-central`:

- a vault repository credential of the project (p15-git-central, sealed to the workers; the master cannot test it):
  assumed present → pass;
- the project's GitHub App / GitLab / Bitbucket connection, when the job's repository is the configured one and the
  job is eligible (trusted source, platform report job or pinned pull request head): the provider is asked for the
  repository (`defaultBranch()`, the connection's own token). Only a **definite** refusal fails:
  - GitHub 404 on the repository, or 404 / 422 on the installation token → `repo_access_denied` (`not_installed`:
    the installation does not include the repository);
  - 401 / 403 (not rate limited) → `repo_access_denied` (`connection_refused`: permission / token invalid or expired);
- otherwise the worker reads anonymously: `RemoteProbe` (`self-heal/remote-probe.ts`) runs one anonymous, hardened
  `git ls-remote --symref <url> HEAD refs/heads/* refs/tags/*` (no clone, no checkout, nothing written — AGENTS.md
  rule 1; no system/global config, no credential helper, no prompt, https only, 15 s, 8 MiB). A credential prompt /
  401 / 403 / "Repository not found" → `repo_credentials_missing` with `why` = `no_connection` (no connection, or a
  plain-git project), `other_repository` (the project's connection is for another repository) or `untrusted_source`.

Everything else (network, 5xx, rate limits, timeouts, ssh URLs, a provider that cannot be built, a preflight error)
passes: the preflight never fails a job on a guess.

A refusal: a `job_auto_events` row `repo_access` (detail: code, why, via, host — identifiers only; migration 0208
extends the kind check), then the orchestrator moves the job `QUEUED → FAILED` with the existing `infeasible` trigger
and the reason `repo_credentials_missing: …` / `repo_access_denied: …` (scheduler status `infeasible`).
No attempt, no lease, no runtime. The job page's "Otomatik işlemler" shows what to fix (`autoMode.job.repoAccess` +
`repoAccessFix`, TR + EN); the chat result card's reason words name the fix (`chat/job-result.ts repoAccessHint`).

Caching: the probe caches per repository (readable 10 min, denied 2 min, unknown 1 min) and shares concurrent probes;
the preflight caches its verdict per project + repository + eligibility (pass 10 min, refusal 2 min). Dispatch runs
every tick for every queued job — this keeps it at most one remote call per repository per window.

Configuration: on in `main.ts` (`orchestration.repoAccess = { probe: new RemoteProbe() }`); off when absent (tests
that do not opt in keep their behaviour; the integration test injects a fake `ls-remote`).

Not covered: the "Invalid username or token" on push of an expired installation token — p15-git-central already
re-requests the credential right before every fetch / push and retries once with a fresh one; the remaining cases were
older workers. The preflight catches a connection that is refused outright.

## §2 Base ref fallback

`BaseRefHealer` (p15-auto-mode §5) already healed missing bases of repositories **with** a project git configuration
(another job's work branch → its result / target / the project base; a missing project base → the repository's default
branch; empty repositories → the p18-project-bootstrap path on the worker). It did nothing for a repository without
one — chat jobs on another repository, projects without a connection — which is where the remaining 12 failures sit.

New `#healAnonymous`: through the same `RemoteProbe` view, a branch or tag that exists → nothing; another job's work
branch (`agent/chat-*`) → that job's merged target / verified head / wait, as before; an empty repository → nothing (the
worker bootstraps it, `workspace-empty-repo-v1`, docs/design/p18-project-bootstrap.md); otherwise the repository's
default branch (remote `HEAD`) with reason `repository_default`. Every heal is the existing `job_base_ref_changes` row +
`base_ref` timeline event + `job.base_ref.heal` audit entry (visible on the job page). Unreadable / unknown → nothing.

`SelfHealService` also keys its "base exists" cache by the job's current attempt: a job back from a failed attempt is
checked again instead of trusting the answer of its first dispatch for 10 minutes.

## §3 Worker: cached clone self-heal

- **Dubious ownership**: `GitRunner` gets `trustRoot` (the workspace root). A command refused with "detected dubious
  ownership in repository at '<path>'" for a path strictly inside the root (never the root, never `..`, never `*`;
  case-insensitive with `/` on Windows) adds `-c safe.directory=<that exact path>` (command-line config is protected
  config, honoured by git) to every later command of the runner and retries once. The worker's git ignores global
  config, so nothing is written to any config file. Logged.
- **Bad object refs**: a fetch failing with `bad object refs/…` / `missing object … for refs/…` runs
  `for-each-ref` over `refs/heads/rac/`, `refs/remotes/`, `refs/tags/` (never IDE branches or anything else), one
  `cat-file --batch-check` to find the refs whose object is missing, one `update-ref --stdin` deleting them, then
  fetches once more. Logged with the removed refs.
- **`git log` timeout**: the pre-push secret scan was `git log -p <attempt> --not --remotes=origin`. When the mirror no
  longer had a remote ref containing the base (squash-merged / deleted / pruned branch, SHA base) it walked the whole
  history with patches. Now `--not <baseCommit> --remotes=origin` bounds it to the attempt's own commits, and the output
  is streamed into `GitLogScan` (line by line, no 64 MiB output cap). Security: the base commit is the master's choice —
  a fetched branch tip or a verified result whose commits were scanned when they were pushed — never content of this
  attempt; the attempt's own commits are all still scanned (test: a token in an old upstream commit no longer refuses a
  clean push; a token in the attempt still does).
- Old workers: `classify.ts` maps dubious ownership / bad object to a transient, machine-specific cause `git_cache`
  (retried on another machine first).

## §4 "head is not a descendant of the base at job start"

The platform rebase (p15-auto-mode, `job_git.auto_rebase`) already covers `(diverged)` on providers with `rebaseOnto`
(GitHub, plain git). Decision: no new automatic path —
`(behind)` / `(identical)` mean the base at job start already contains the attempt's head: there is nothing to rebase
(a rebase would produce an empty change), so it is not safe to "heal" into a success. The messages now say what
happened and what to do: `behind`/`identical` → "the base already contains this attempt's head, so there is nothing new
to merge; run the job again on the current base"; a diverged attempt whose rebase was `unsupported` (GitLab /
Bitbucket), `moved` or threw → the reason names that and "run the job again on the current base"; the chat card says
so in TR / EN.

## Tests

- worker `test/workspace-git-heal.test.ts` (temp repositories): broken attempt refs pruned and fetch retried; dubious
  ownership (`GIT_TEST_ASSUME_DIFFERENT_OWNER` through a git wrapper) trusted only inside the root; scan bounded by the
  base commit; streamed scan equals the whole-log scan across chunk / UTF-8 boundaries.
- master `test/unit/git-preflight.test.ts`: probe parsing / classification / argv / cache; preflight verdicts for each
  credential path; chat hints TR / EN; `git_cache` classification.
- master `test/integration/repo-access.test.ts` (Postgres): a private repository fails at dispatch (`infeasible`, no
  attempt, `repo_access` event, cached verdict); public / unreachable repositories pass; a missing chat work branch of a
  repository without configuration heals to its default branch.

## Rollout

Worker change → a worker release is needed for §3 (old workers keep working; the master classifies their failures as
`git_cache`). No protocol change. Migration 0208 (additive constraint change, rollback in the file). Live check
wanted: a job on a private repository without a connection fails at once with the fix on the card; the Windows worker's
next dubious-ownership fetch heals itself.

## Changelog

- fix(master,worker,web,i18n): **A job whose repository cannot be read now fails before any machine starts it and says what to fix; missing chat branches fall back to the default branch, and workers repair their own git cache** (p22-git-preflight, [design](p22-git-preflight.md); evidence: ~45 of 102 failed jobs in 14 days were git environment failures). The master checks repository access before dispatch (the project's GitHub / GitLab / Bitbucket connection, else an anonymous `ls-remote`, cached) and fails a job with `repo_credentials_missing` / `repo_access_denied` plus a TR/EN fix on the job page and chat card (migration 0208); base refs of repositories without a git configuration are healed to the remote's default branch; workers trust their own dubiously-owned cache paths exactly (`safe.directory`, never `*`), prune refs to missing objects and retry, and the pre-push scan walks only the attempt's commits (streamed). Diverged/behind verification failures explain why and what to do.
