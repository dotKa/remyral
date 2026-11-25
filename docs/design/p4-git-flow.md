# Design note: P4 git flow — branches, verification, conflicts, PRs, CI, protected merge

- **Status:** Implemented (GitHub provider **UNVERIFIED-LIVE**, see §11)
- **Date:** 2026-10-13
- **Backlog:** `p4-git-flow` — acceptance A-ORCH-4 (conflicting branch edits produce reviewable conflicts, not
  silent overwrite) and A-ORCH-5 (explicit approval for protected merge and destructive actions).
- **Decisions applied:** ADR-0004 §3 (attempt identity in branch + trailer; force-with-lease only with an
  expected ref), ADR-0006 §3 (short-lived per-repository installation tokens minted by the master, never
  persisted), ADR-0010 (repository content has no authority; no git write credentials for untrusted
  sources; integration only via the integrator + human approval), ADR-0003 (Postgres is the source of truth).
- **Builds on:** [p4-orchestration.md](p4-orchestration.md) (VERIFYING, JOB_CREDENTIAL, remote inspection),
  [p3-workspace-and-secrets.md](p3-workspace-and-secrets.md) (`rac/<jobId>/<attemptId>`, trailer,
  `push()` with lease + pre-push secret scan), [p3-sandbox.md](p3-sandbox.md) (worker commits from the
  per-attempt view after the tamper check), [p4-approvals.md](p4-approvals.md) (platform floor:
  `git.merge`, `git.push_protected`, `git.force_push` never `allow`).
- **Threat model:** T-INJ-2, T-INJ-3, T-WRK-2, T-OPS-1 (security review §10).
- **Since p11-merge-pipeline (ADR-0041):** jobs whose changes reach the target through a master-managed integration
  (sub-jobs and their coordinator, workflow steps feeding a master integration, the integration's own jobs) get no pull
  request of their own; the integration opens ONE PR from `int/<root8>` and its head job's protected merge (this note,
  §6) merges it. Providers gained `updateBranch` (create / fast-forward only) and `updatePullRequest` —
  [p11-merge-pipeline.md](p11-merge-pipeline.md).

## 1. Shape

```
packages/protocol      ASSIGN_JOB.execution.pushResult (optional, additive)
apps/worker/src/workspace/publish.ts   publishAttempt(): worker commit with trailer → push rac/… (lease, scan)
apps/worker/src/jobs/runner.ts         after assertTrustedGitUnchanged: publish when pushResult; JOB_RESULT.commits
apps/master/migrations/0016_git_flow.sql   project_git_configs, job_git, git_merge_requests
apps/master/src/gitflow/
  types.ts            GitProvider interface, MergeCheck, CiStatus, ProviderError(transient)
  refs.ts             attempt/target branch rules, repository URL canonicalisation, trailer parsing
  flags.ts            review flags for CI config / dependency manifests / repository policy files (T-INJ-3)
  git-exec.ts         hardened git for the master (no hooks/filters/attributes/system config, https/ssh only)
  local-provider.ts   LocalGitProvider: plain git remotes + the end-to-end test provider
  github-app.ts       GitHubAppAuth: RS256 app JWT, per-repository installation tokens
  github-provider.ts  GitHubProvider: REST via fetch (no SDK)
  providers.ts        production factory (GitHub App by keyRef; plain git only when enabled)
  config-store.ts     PUT /projects/:id/git validation + audit (no secrets)
  service.ts          GitFlowService: base capture, verification, refresh, requests, gate hook, execution
  credentials.ts      GitHubWorkerCredentials (JOB_CREDENTIAL), ProviderBranchInspector (recovery)
  routes.ts           REST (§7)
apps/master/src/approvals/service.ts   + GateDecisionHook, evaluate(…, {onCreated})
apps/master/src/orchestration/*        hooks: prepareDispatch, pushResult, verification instead of the claim
apps/web/src/screens/ChangesPanel.tsx  job detail "Changes" panel
```

## 2. Provider abstraction

`GitProvider` = `branchHead`, `commit`, `compare(base…head)`, `testMerge`, `ensurePullRequest`, `checks`,
`merge` (sha-guarded), `findMerge` (idempotency on retry via the `Remyral-Merge: <requestId>` trailer of the
merge commit), `deleteBranch(branch, expectedSha)`. Errors are `ProviderError{transient}`.

- **GitHub** (`GitHubProvider` + `GitHubAppAuth`): `fetch` against the REST API version `2022-11-28` (no
  Octokit: eleven endpoints do not justify a dependency and its transitive surface). Endpoints were checked
  against the GitHub REST documentation (Context7 `/websites/github_en_rest`): `POST
  /app/installations/{id}/access_tokens` (`repositories`, `permissions`), `GET git/ref/heads/{b}` (exact
  match, unlike `git/refs`), `GET git/commits/{sha}`, `GET compare/{base}...{head}`, `GET/POST pulls`, `GET
  pulls/{n}` (`mergeable` null while computing), `PUT pulls/{n}/merge` (`sha` precondition, `merge_method`;
  405 not mergeable, 409 head moved), `GET commits/{sha}/check-runs`, `GET commits/{sha}/status`, `GET
  commits?sha=`, `DELETE git/refs/heads/{b}`. 5xx / 429 / 403 with `x-ratelimit-remaining: 0` are transient.
  Master tokens: `contents:write, pull_requests:write, checks:read, metadata:read`, one repository, cached
  until 5 min before expiry. Worker tokens: `contents:write, metadata:read`, one repository, minted per
  request, never cached.
- **Plain git** (`LocalGitProvider`): refs always read with `ls-remote`; objects fetched on demand into a
  bare cache (`GITFLOW_CACHE_DIR`, 0700) — no worktree, no checkout. Test merge with `git merge-tree
  --write-tree --name-only -z` (exact conflict files); merge = `commit-tree` (two parents, or one for
  squash) + a **plain push** of that commit to the target: its first parent is the target's current head, so
  the update is a fast-forward only while the target has not moved — never a force push. Attributes are read
  from the empty tree (`attr.tree`), so a change that adds `* merge=union` cannot turn a conflict into a
  silent clean merge (tested). Off in production unless `GITFLOW_PLAIN_GIT=true` (AGENTS.md rule 1: the
  control plane fetches objects, which is close to checking out repositories; GitHub projects need nothing
  but API calls).

## 3. Branch naming and worker publication

The worker pushes exactly `rac/<jobId>/<attemptId>` (p3-workspace). New: when `ASSIGN_JOB.execution.pushResult`
is set (the master sets it for jobs enrolled in git flow), after a successful run and after
`assertTrustedGitUnchanged`, `publishAttempt` records the final tree as one worker commit `remyral: <summary>`
with exactly one `Remyral-Attempt: <attemptId>/<epoch>` trailer — **the epoch the attempt holds now** (a
resumed attempt commits with its new epoch) — and pushes with `--force-with-lease=<ref>:` (must not exist),
after the pre-push secret scan with the daemon's exact-value set. The pushed `{branch, sha}` goes into
`JOB_RESULT.commits` — a claim the master only compares (§4). Push/scan failures fail the attempt
(`PushRejectedError`, `SecretScanError`). Absent flag = no push (older masters, projects without git flow).

## 4. Independent verification (VERIFYING, T-WRK-2)

A job is **enrolled** when its project has a `project_git_configs` row at dispatch: `prepareDispatch` (outside
the dispatch lock) creates `job_git` and captures the **base at job start** (target head, or the job's sha
base). JOB_RESULT{succeeded} → `run_finished` → the job stays in VERIFYING (no more
`verification_passed_no_approval` on the worker's word) and `verify()` runs after commit (also from the loop
and after `reconcile_finished`). While it inspects the remote it extends the attempt's lease (the worker let
go) so the job does not go LOST.

Verification fails the job (`verification_failed`, audited `git.verify` denied) unless **all** hold:
1. the job's repository equals the project's configured repository;
2. the base at job start was captured;
3. `rac/<jobId>/<attemptId>` exists on the remote;
4. its head commit carries exactly one `Remyral-Attempt` trailer (in the trailer block) equal to
   `<currentAttemptId>/<current lease epoch>` — a commit from a superseded epoch or another attempt is
   refused (tested: an epoch-1 zombie pushes after a resume under epoch 2);
5. a worker claim (`JOB_RESULT.commits`) for that branch equals the remote head;
6. the head descends from the base at job start (`compare` status `ahead`).

Then diff stats (commits ≤ 250, files ≤ 300, totals), review flags, a pull request (GitHub), the test merge
and CI checks are recorded (failures there are informational and refreshed later). No file changes →
`verification_passed_no_approval` (nothing to merge). Otherwise `verification_passed` → AWAITING_APPROVAL
with the merge state in the transition reason (`needs_rebase: conflicts in N file(s)` when conflicting).
Transient remote errors are retried until `verifyTimeoutMs` (10 min), then the job fails closed.

## 5. Conflict detection (A-ORCH-4)

`testMerge` → `clean | conflicts(files, headCommits, baseCommits, precision) | base_moved | unknown`:
- **base_moved**: the target no longer contains the base at job start (rewritten / force-pushed) or is
  missing → needs a human rebase.
- **conflicts**: plain git: exact files from `merge-tree`, plus the commits on each side since the merge base
  that touch them. GitHub: the API only says `mergeable: false`; files are approximated as those changed on
  both sides since the merge base (a superset, labelled `approximate`), with both sides' commits.
- **unknown**: GitHub still computing; the loop asks again.

The record is stored in `job_git.merge_state/merge_check`, re-checked by the loop every `refreshIntervalMs`
(30 s) while the job awaits a decision, again when a merge is requested and again right before it executes.
Conflicts never auto-resolve and the target is never force-pushed; `POST /jobs/:id/merge` answers 409
`merge_conflicts` / `needs_rebase`. A human may accept the result unmerged (`leave_open`, PR stays open),
reject it (deny), discard it (§6), or cancel the job.

## 6. Protected merge and destructive actions (A-ORCH-5)

> **Since p15-merge-approvals** ([design](p15-merge-approvals.md), migration 0124): the master opens the merge
> decision itself when verification moves the job to AWAITING_APPROVAL (same transaction; `requested_by` NULL),
> the owner's security policy may approve it (`approved_via = security_policy`, system `approval_auto_granted`),
> and a person's request below supersedes the master's pending one. The rest of this section is unchanged.

`POST /jobs/:id/merge {mode}` (operator+) → `ApprovalService.evaluate({action: 'git.merge', approvalKey:
'<mode>.<n>', requestedBy: system gitflow})`; the `git_merge_requests` row (head sha, base sha, target,
method) is inserted **in the same transaction** as the approval request (`onCreated`). The platform floor
makes it admin + step-up (or stricter by project policy); `allow` is impossible and treated as a refusal.

**Gate hook** (`GateDecisionHook`, called inside `decide` when a gate request closes): approved `merge` /
`discard` → request `approved`, job stays AWAITING_APPROVAL (`deferred`), execution kicked after commit;
approved `leave_open` → default `approval_granted` (SUCCEEDED); denied → default `approval_denied` (FAILED),
except a denied discard, which only closes the request. Requests without a git flow row keep the old
behaviour.

**Execution** (claim `approved → executing`, crash-safe re-claim after 5 min): job must still be
AWAITING_APPROVAL; `findMerge` (already merged by an interrupted run → finish); **sha guard**: the attempt
branch must still be at the approved head (else `refused: head_moved`; GitHub additionally enforces it with
`sha`); fresh test merge (conflicts / base_moved → refused); `requireCi` → checks must be `success`; then
`merge`. Success: request `merged`, `job_git.merged_sha`, audit `git.merge` (system gitflow, with the
approving user and approval id), and `approval_granted` **as the approving user** (the approval authorised
it) → SUCCEEDED. Refusal: request `refused` with the reason, audit `git.merge` denied, job stays
AWAITING_APPROVAL (a new request is possible). The job reaches SUCCEEDED only after the merge or after an
approved `leave_open`.

**Destructive actions**: deleting the attempt branch (`POST /jobs/:id/discard`) is classified
`git.force_push` (a destructive ref update) — platform default **deny** (403 `approval_required`, nothing
deleted); a project may relax it to `require_approval` (floor: admin + step-up, ≤ 24 h). On approval the
branch is deleted only at the approved sha (`--force-with-lease` / ref re-check) and the job becomes FAILED
(`approval_denied` as the approver, "result discarded"). The master never force-pushes; agents never get
these operations (the worker only ever pushes its own `rac/…` ref with a lease, and the agent never sees the
token).

## 7. REST

| Route | Authz (`config.authz`) | Notes |
| --- | --- | --- |
| `GET /jobs/:id/changes` | `jobs.read` (job's project) | branch, head, verification, commits, files, totals, flags, merge check (files + both sides' commits), PR, CI, merged sha, requests; `enabled:false` when not enrolled |
| `POST /jobs/:id/merge` `{mode: merge\|leave_open, reason?}` | `jobs.merge` (operator+) | 202 `{request, created}`; idempotent while a request is open; 409 `merge_conflicts` / `needs_rebase` / `ci_not_passed` / `merge_check_pending` / `not_awaiting_approval` / `not_verified` |
| `POST /jobs/:id/discard` `{reason}` | `jobs.merge` | 403 `approval_required` unless the project allows `git.force_push` with approval |
| `GET /projects/:id/git` | `projects.git.read` (viewer+) | no secrets |
| `PUT /projects/:id/git` `{expectedVersion, provider, repositoryUrl, baseBranch, mergeMethod?, requireCi?, ciTimeoutSec?, github?{installationId, keyRef?, appId?}}` | `projects.git.write` (admin) + step-up + CSRF | 409 version conflict; 400 with field codes; audited `project.git.update` |

All five are in the route-coverage list and the generated RBAC matrix (new actions `jobs.merge`,
`projects.git.read`, `projects.git.write`). The GitHub App private key is never sent or stored: the project
names a `keyRef` (`default`) that the master resolves from `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY_FILE`. Since p5-github-connect (ADR-0022) the keyRef `panel` names the App connected in Settings → Integrations, whose
key the master stores encrypted; it takes precedence when a request names no keyRef (docs/design/p5-github-connect.md).

## 8. Console

Job detail → **Changes**: branch @ head, target, verification status/reason, PR link, CI (required flag,
check list), diff stats, review-flag warning (CI config, dependencies, repository policy, hooks), file list,
merge state (clean / conflicts with files and both sides' commits / needs rebase / computing), merge
requests with links to their approvals, and **Request merge** (disabled unless clean) / **Accept without
merging** — both only open the approval; the approver decides on the Approvals screen through the step-up
dialog. All repository text is rendered as text (test with a hostile file name / subject).

## 9. Tests

- `apps/master/test/integration/gitflow.test.ts` (4; real master + Postgres + BullMQ, real worker daemons over
  WebSocket, real worktrees and pushes to a local bare repository, plain-git provider, fake runtime that edits
  files): two jobs edit `README.md` → both verified (trailer, ancestry, diff) → merge request opens the
  approval only → stale TOTP refused (403 `step_up_required`, nothing merged) → step-up + approve → merge
  commit on `main`, job SUCCEEDED by the user; the second job then shows `conflicts` with the file and both
  sides' commits, `POST merge` → 409, job stays AWAITING_APPROVAL, accepting unmerged needs the approval too;
  head moved after the request → approved merge refused `head_moved`, `main` untouched, audit denied;
  discard → 403 by default, with a project rule → approval + step-up → branch deleted, job FAILED; partition
  → resume under epoch 2 → worker commits `…/2` → an epoch-1 commit lands on top → verification refuses.
- `apps/master/test/unit/gitflow-github.test.ts` (12; fixture HTTP): JWT claims/signature, token request
  body (one repository, explicit permissions), caching only for master tokens, non-RSA key refused, errors
  without bodies; branch head exact-match + 404; PR create / 422 race / existing; checks + statuses → CI
  state; merge with `sha` + method; 405/409/403 → refusals; sha guard before calling merge; test merge
  clean / unknown / conflicts (approximate) / base rewritten; transient vs final errors; `findMerge`; delete
  only at the expected sha.
- `apps/master/test/unit/gitflow-local.test.ts` (9; real git): refs/URL/trailer/flag rules; commit parsing;
  file URLs refused unless allowed; compare; exact conflicts with both sides' commits despite `merge=union`;
  merge refused on conflicts; moved head refused; merge commit (two parents) + squash (one) + `findMerge`;
  delete at expected sha / moved / absent; rewritten base → `base_moved`.
- `apps/worker/test/job-runner.test.ts` (+1): `pushResult` → branch on the origin with the trailer, claimed in
  JOB_RESULT.
- `apps/web/test/jobs.test.tsx` (+2): Changes panel (stats, flags, PR, request → approval link, body
  `{mode}`); conflicts with hostile file names as text; merge button disabled.
- Route coverage + RBAC matrix updated; existing orchestration/approvals suites unchanged (projects without a
  git configuration keep the earlier behaviour).

## 10. Security review

| Threat | Mitigation | Residual / follow-up |
| --- | --- | --- |
| **T-WRK-2** fake results | Success needs the remote: branch exists, head trailer = current attempt/epoch, worker claim = remote head, descends from the base captured before dispatch; diff computed by the master; transient errors fail closed after 10 min. | A worker holding a valid push token can still push *some* commit with the right trailer (it is the attempt): verification proves provenance, not quality — human review + CI + approvals cover quality. Projects without a git configuration still accept the claim (documented; configure git flow). |
| **T-INJ-2** injected push/merge/deploy | The agent never sees git credentials (credential helper in the worker's git only); the worker pushes only `rac/<job>/<attempt>` with a lease; merges/deletions run only on the master after an approved gate request (floor: admin + step-up), bound to the head sha; untrusted sources get no GitHub write token (ADR-0010 §3). | A GitHub installation token with `contents:write` can technically update other branches if a compromised worker misuses it during its lifetime — **branch protection / rulesets on the target are required** (docs/ops/github-app.md); untrusted-source jobs on GitHub currently cannot publish at all (master-mediated push is a follow-up). |
| **T-INJ-3** malicious change merged | Human approval with the diff stats, review flags (CI config, dependency manifests, AGENTS.md/CODEOWNERS/.gitattributes, hooks) in the request summary and the panel; optional required CI; sha guard so what is merged is what was reviewed; attributes ignored in test merges. | No content diff viewer yet (stats + file list + PR link); SBOM diff is p7-supply-chain. |
| **T-OPS-1** duplicate side effects | Execution claim (`approved → executing`) and in-process de-duplication; `findMerge` by `Remyral-Merge` trailer makes a retried merge a no-op; plain push / GitHub `sha` refuse concurrent target moves; one open request per job (unique index); PR creation finds the existing PR (422 race). | GitHub branch deletion has no compare-and-swap (re-check right before; small TOCTOU). |
| Protected-merge bypass via policy | `git.merge`/`git.force_push` evaluated through the approval engine with the platform floor; `allow` treated as refusal; approval requests and merge requests created atomically. | — |
| Secrets | App key file 0600 (refused otherwise), never logged/stored/sent; tokens only in memory; worker tokens via non-durable JOB_CREDENTIAL; provider errors carry status codes, not bodies; audit metadata has ids/shas only. | KMS envelope encryption (ADR-0006 §1) for the App key is not implemented — key file on the master host (deviation, same as the lease key). |
| Repository content on the control plane | GitHub: API only. Plain git: objects only (no checkout), hooks/fsmonitor/filters/attributes/system+global config disabled, https/ssh only, bounded output/time; disabled unless `GITFLOW_PLAIN_GIT=true`. | Git CVEs in object parsing — keep git updated on the master. |
| XSS / injection via repository text | Subjects, paths, reasons rendered as React text; zod-validated responses; summaries length-bounded. | — |

## 11. Rollback, operations, UNVERIFIED

Rollback: revert the commits; migration 0016 only adds tables (forward-only runner: keep the schema or
restore from before it). Jobs of projects without a `project_git_configs` row behave exactly as before;
deleting a project's row stops enrolment of new jobs. Workers of this build talk to older masters
unchanged (`pushResult` absent ⇒ no push).

Operational signals: `git.verify` denied count + reasons, `git.merge` denied reasons (`head_moved`,
`conflicts`, `ci_not_passed`), requests stuck in `approved`/`executing`, `job_git` rows with `base_sha IS NULL`
for running jobs, merge state `conflicts`/`base_moved` counts, CI `timed_out`; logs `git flow: …`.

**UNVERIFIED-LIVE:** the whole GitHub path (App auth, PR, checks, merge, delete, worker tokens) — tested only
against fixtures because the owner has no GitHub repository yet; first live run per docs/ops/github-app.md.
Also unverified: GitHub Enterprise Server URLs; plain git over ssh/https from a real master host (tests use
`file://`); Windows masters.
