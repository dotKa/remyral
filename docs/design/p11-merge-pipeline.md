# Design note: master-managed integration — one integration branch, bounded conflict resolution, one pull request (P11)

- **Status:** Implemented (GitHub PR path fixture-tested only; live run UNVERIFIED, §13)
- **Date:** 2026-10-18
- **Backlog:** `p11-merge-pipeline` (also closes `p8-subtasks-codex`; Pi half of `p8-subtasks-others`)
- **Owner decision (2026-10-18):** "for combining code from several agents choose the model that makes most sense
  long-term" — delegated; decided (by Claude): **master-managed integration ending in ONE pull request**, not "each
  sub-job opens its own PR". Recorded in **ADR-0041**.
- **Builds on:** [p8-orchestration.md](p8-orchestration.md) (sub-jobs, ADR-0031), [p4-dag.md](p4-dag.md) §5–6
  (workflow outputs, integrator), [p4-git-flow.md](p4-git-flow.md) (verification, conflicts, protected merge),
  [p3-workspace-and-secrets.md](p3-workspace-and-secrets.md) (`rac/<job>/<attempt>`, trailer, pre-push scan),
  [p10-verify-health.md](p10-verify-health.md) (the repository verifier checklist).
- **Migration:** 0089 (0087 / 0088 = parallel p11 work; renumber at merge if taken). **Worker release:** yes (new
  feature `integration-v1`, Codex / Pi sub-job tools, `paths`).

## 1. Problem

Before this change, combining the work of several agents had no owner:

| Situation | What happened |
| --- | --- |
| A coordinator job delegated to repository sub-jobs (`request_subtask`) | Each sub-job ran on its own worktree and branch `rac/<job>/<attempt>` (work label `sub/<parent8>/<req8>`), was verified by git flow and waited in AWAITING_APPROVAL — **with its own pull request** on GitHub. Nothing ever merged the sub-job branches into the coordinator's or into each other; a human had N PRs that may conflict with each other. |
| A workflow with an integrator step | The integrator was an ordinary **agent job** told to "integrate the upstream branches" — non-deterministic, unverifiable which commits it really merged, a conflict meant "the agent improvised"; the engine then opened a protected merge of the integrator's branch only (p4-dag §6). |
| Conflicts | Detected only against the target (p4-git-flow §5) and only reported (409 `merge_conflicts`); never resolved. |
| Tests on the combined result | None: each job was verified alone. |
| Sub-job tools | Claude Code only. |

Bug found on the way: the sub-job cascade (`SubtaskService.cascade`) cancelled sub-jobs in **AWAITING_APPROVAL** when
the coordinator ended without changes (SUCCEEDED) — destroying verified work. Fixed: a sub-job waiting for a decision
has finished its run and is never cancelled by the cascade.

## 2. Decision in one picture

```
coordinator job R (repository project, git flow, integration mode "master")
  ├─ sub-job A ─ verified rac/A/… ┐   each member: verified by git flow, NO own PR
  ├─ sub-job B ─ verified rac/B/… ├─ all settled (R AWAITING_APPROVAL / SUCCEEDED, no sub-job running)
  └─ sub-job C ─ verified rac/C/… ┘
        │  tick step "integration" (master, deterministic)
        ▼
  int/<R8> := target head (base)          order: dependencies → clean siblings → overlapping ones → R itself last
  round 1: INTEGRATION job (kind "integration", worker, real git, NO agent)
           merge --no-ff A ✓  B ✓  C ✗ conflict README.md → abort, report markers + both diffs
           push rac/<int-job>/… → git flow verifies (trailer, ancestry) → master fast-forwards int/<R8>
  RESOLUTION job (agent, R's policy) on int/<R8>: rewrites ONLY README.md (both sides' diffs, markers, task texts as data)
           → verified → files ⊆ conflict set checked
  round 2: INTEGRATION job: merge C taking README.md from the resolution ✓, merge R ✓ → int/<R8> fast-forwards
  VERIFIER job (p10 repository checklist: build / lint / tests or the project's test command) on int/<R8>
           fail → FIX job (bounded) → verified → int/<R8> fast-forwards → verifier again
  ONE pull request int/<R8> → target with a generated description (GitHub)  |  plain git: the protected merge
  merge = a human: the head job's protected merge (git.merge, admin + step-up) or GitHub's own protected PR merge
        ▼
  merged → members' AWAITING_APPROVAL jobs approved by the approver of the merge, job_git.merged_sha recorded
```

Workflows: an integrator step in such a project is **not run as an agent** any more; the engine hands its ancestor
steps' verified branches to the same pipeline (§9).

## 3. Members, base, order

**Members (coordinator):** every job of the family (`job_subtasks.root_job_id = R`) in AWAITING_APPROVAL with a
passed git-flow verification and no merge yet, plus R itself when it has verified changes. Discovery (tick step
`integration`) waits until R is AWAITING_APPROVAL or SUCCEEDED, no family job is still open, at least one member has
changes, the project has a git configuration and its integration mode is `master`. Only roots (a sub-job is never a
coordinator of its own integration), only jobs started by a person (the integration acts for them), only coordinators
that finished within the last 24 h (no surprise integrations of old work after an upgrade).

**Base:** the target branch's head when the integration starts (`GitFlowService.targetBranch(R)`), so the PR merges
cleanly against the target as it is and the tests run on the real result. `int/<root8>` (first 8 hex characters of
R's id; for workflows of the run id) is created at the first verified round.

**Order** (`orderMembers`, project setting `integration_order`):
1. dependencies first — a sub-job after its own sub-jobs (it waited for them), the coordinator last; workflow steps
   after their upstream steps;
2. among members ready at the same time: those whose `paths` overlap no sibling's first (clean merges land before the
   likely conflicts, so a resolution job sees as much integrated work as possible);
3. then creation time (`dependency`, default — the order the coordinator delegated) or completion time (`completion`).

A cycle (impossible from the data, never trusted) falls back to time order.

## 4. The integration step (worker, no agent)

A job with `spec.kind = "integration"` and `spec.integration` (`IntegrationPlan`: integration id, round, branch,
steps `{position, label, branch, sha, resolution?}`) — created **only** by the integration service
(`JobStore.create({integration: true})`; `POST /jobs` refuses the kind). Its runtime / sandbox profile / approval policy
are the coordinator's, as **labels**: no runtime starts, placement does not require the runtime (`integration`
placement fact: needs `integration-v1` and `git`, a slot; skips runtime, login, sandbox-profile and model checks).

Worker (`apps/worker/src/jobs/integration.ts`, `JobRunner.#runIntegration`):
1. credential + `WorkspaceManager.prepare` exactly like an agent attempt: the mirror fetches every head, the worktree is
   created on `rac/<job>/<attempt>` at `baseRef` = the integration head (a sha);
2. per step in order: the commit must exist (`missing` → stop); contained already → `already`; else
   `git merge --no-ff --no-commit <sha>`:
   - clean → merge commit (`Merge <label> into int/…`, trailer `Remyral-Integration: <id>/<position>`);
   - conflicts: the unmerged paths (`diff --diff-filter=U -z`); when the step carries a resolution covering every one of
     them, each file is taken from the resolution commit (`checkout <res> -- f`, or removed when the resolution deleted
     it), refused when a conflict marker line remains; else the merge is **aborted** and the step reports
     `conflict` with every conflicting path and, for the first 8, a conflict-marker excerpt (diff3 style, regions ±3
     lines, ≤ 6 KiB) and both sides' diffs against the merge base (≤ 6 KiB each), redacted;
   - the round stops at the first conflict / missing commit (later steps `skipped`);
3. git hardening on top of the workspace's (no hooks, no global/system config, https/ssh only): attributes from the
   **empty tree** (`attr.tree`, `core.attributesFile=/dev/null` — a branch adding `* merge=union` / `-merge` / a custom
   driver cannot turn a conflict into a silent merge or run anything; tested), `rerere.enabled=false`,
   `merge.verifySignatures=false`, `core.editor=true`, `commit.gpgSign=false`, identity = the project's git identity;
4. publish like any attempt (`publishAttempt`: trailer commit, pre-push secret scan, `--force-with-lease` push of
   `rac/<job>/<attempt>`), then the report as artifact `integration-report.json` (`IntegrationReport`, ≤ 512 KiB).
   A conflict is a **successful** step (the master decides what follows). Failure / cancel are ordinary job failures.

Master: the report artifact is accepted only from `kind: integration` jobs, parsed strictly, its text redacted again
and stored as `job_artifacts.kind = 'integration'`. Before the integration branch moves, the claims are checked on the
remote (T-WRK-2): git flow verified the pushed branch (trailer = attempt/epoch, ancestry from the job's base); the
result must descend from the current integration head; every commit reported `merged` / `resolved` / `already` must be
contained in it. Then `int/<root8>` **fast-forwards** to the verified head (`GitProvider.updateBranch(branch, sha,
expected)`: created when absent, else only from the expected value and only as a fast-forward — never forced; a moved
or rewritten branch stops for a human).

## 5. Conflict resolution (agent, bounded)

On a conflict the master opens a **resolution job** — an ordinary agent job of the project, created as the person the
integration acts for (re-authorised `jobs.create`), with the coordinator's runtime, model, sandbox profile, approval
policy and source trust, its limits capped at 1 h, no secret references, no deploy / site bundle / previews, checked out
at the integration head. Its prompt (`resolutionPrompt`) says: rewrite ONLY the listed files, combine both sides, no
markers, no `git merge`, no commit / push; and gives, **fenced as data** (ADR-0010, the same fence escaping as workflow
upstream outputs): the already-integrated tasks, the incoming task's title and prompt (≤ 2 KiB), per file the conflict
markers and both sides' diffs.

Its verified result is accepted only when it descends from the integration head and changed **every** conflicting
file (extra files are logged and ignored — the worker takes exactly the conflicting files); then the next integration
round applies it. A failed, empty or incomplete resolution counts as a round. At most `integration_max_resolutions`
(default 3, 0–10) rounds per integration; then `needs_human` with the reason ("resolve it on int/… by hand").

## 6. Integration tests and fixes

When every branch is merged: a **verifier job** with the p10-verify-health repository checklist (`verifierSpec`,
`type: repo`, the project's test command or `package.json` build / lint / test; runtime = the project's verification
runtime, else the coordinator's) checked out at the integration head; its report is read with the p10 parser
(`readVerifierFiles`, `combine`, `stateOf`).
- `passed` / `warned` → publish;
- `failed` → a **fix job** (agent, same policy as §5, prompt `fixPrompt`: failed checks and findings fenced as data, "do
  not delete / skip / weaken tests, do not change CI or dependencies unless that is the failure") — its verified result
  must descend from the integration head; `int/<root8>` fast-forwards and the verifier runs again; at most
  `integration_max_fixes` (default 1, 0–5), then `needs_human`;
- `error` (the verifier could not run / no report) → publish, the PR description says the tests did not run (merging is
  a human decision either way).

## 7. One pull request, merging

- **GitHub:** `ensurePullRequest(int/<root8> → target)` with a generated description (`prBody`): tasks (title, job,
  runtime, machine, branch, merge outcome / resolved by), the merge and conflict log, round counts, the verification
  (state, summary, checks). Untrusted text is escaped (`mdText`: one line, no HTML / links / mentions / table breaks)
  and the body is redacted. An existing PR's description is updated (`updatePullRequest`, `PATCH pulls/{n}`).
- **Every member** (sub-jobs, the coordinator, workflow steps feeding a master integration, the integration's own jobs)
  gets **no pull request of its own**: `GitFlowService` asks the integration service (`ownPullRequest`) before
  `ensurePullRequest` at verification and refresh.
- **Merging** stays a human decision, unchanged: the integration's **head job** (whose verified `rac/` branch is at the
  integration head) carries the PR (`job_git.pr_number`) and the integration's base and target, so the existing protected
  merge applies — `POST /jobs/<head>/merge` → `git.merge` approval (admin + step-up by the platform floor), sha guard,
  fresh test merge, optional required CI. On GitHub a person may also merge the PR there (branch protection rules apply
  as before). Plain git repositories: the same protected merge (merge commit pushed without force).
- **Merged** (`ready` polls: the head job's `merged_sha`, else the target containing the integration head): state
  `merged`; members still in AWAITING_APPROVAL are approved (`approval_granted`) **as the person who approved the
  integration's merge** and their `job_git.merged_sha` names the merge; when the PR was merged on the provider directly
  (no approver known) they are left for a person.

## 8. Ownership (`paths`) — reduce conflicts up front

- `request_subtask` takes `paths` (≤ 32 relative paths / globs the sub-job owns; `SubtaskPath`: no leading `/`, no `\`,
  no `..`). Stored in `job_subtasks.paths`.
- The coordinator's tool preamble (repository jobs) now says: split the work by disjoint files / directories, state
  `paths`, do not edit your sub-jobs' files, do not merge sub-job branches yourself — the platform integrates them.
- At request time the master compares the new claim with every sibling's (`claimsOverlap`: a glob claims its prefix,
  overlap on path-segment boundaries — conservative): an overlap is a **warning**, not a refusal — a note in the
  sub-job's placement (job page) and `SUBTASK_STATUS.detail` to the agent. The integration repeats the warnings
  (`integrations.warnings`, UI callout, PR log) and orders overlapping siblings last (§3).

## 9. Workflows

`IntegrationMergeGateway` (wraps the git-flow gateway) adds `masterIntegration`. When an integrator step becomes ready
in a project with integration mode `master` and git flow, the engine (`#masterIntegrate`) hands it every **ancestor**
step's job (with their upstream edges as dependencies); the integration takes those in AWAITING_APPROVAL with verified
changes. The integrator's own agent job is cancelled ("integrated by the master — no integrator agent"); the step waits
in `awaiting_merge` with outputs `{branch: int/<run8>, summary: …}`; `workflow_merge_requests.external_ref =
integration:<id>`; merged → step succeeded (its deploy step runs as before), `needs_human` / `failed` / `cancelled` →
refused → step failed. Projects with integration mode `off` (or without git flow) keep the agent integrator exactly as
before.

## 10. Sub-job tools per runtime

| Runtime | Tools | How |
| --- | --- | --- |
| Claude Code | yes (since p8) | in-process MCP server `remyral-subtasks` |
| Codex 0.162.1 | **yes** | app-server **dynamic tools** (`thread/start.dynamicTools`, server request `item/tool/call`, answer `{contentItems, success}`), `initialize.experimentalApi` only when the job has the tools; verified against the generated protocol of the pinned binary and a real-binary test with the mock Responses API (docs/compat/codex.md §12) |
| Pi 1.1.0 | **yes** | a generated extension (`-e`, after the permission gate) registers the tools; each call is relayed as an `extension_ui_request` the adapter answers from the tool host; the gate pre-approves exactly these names for jobs that have them; real-binary test with the faux provider (docs/compat/pi.md §13) |
| OpenCode 1.19.0 | **yes** (p11-fixes-a, [ADR-0045](../adr/0045-opencode-subtask-tools-file-relay.md)) | a **local (stdio) MCP server** OpenCode starts itself (`mcp.remyral-subtasks: {type: "local"}` — the OpenCode binary in Bun mode running a generated script), relayed through **files** in the attempt's runtime state dir; see below |

**OpenCode (p11-fixes-a):** the earlier blocker was the channel — the ops-chat `remote` MCP endpoint needs a loopback
connect, which every job sandbox forbids (`apps/worker/src/sandbox/network.ts` FORBIDDEN, Seatbelt only lets OpenCode
*listen*, containers cannot reach the host loopback). The fix needs **no sandbox change**: OpenCode spawns the MCP
server as its own child, so the server inherits exactly the job's confinement; the server writes each call as
`<uuid>.req.json` into `<runtime state dir>/…/subtask-relay/` (the per-attempt dir every profile already lets the
runtime write; containers mount it at the same path) and waits for `<uuid>.res.json`, which the adapter writes from
`SpawnContext.subtaskTools` (`packages/agent-adapters/src/runtimes/opencode/subtask-relay.ts`). The session ruleset
allows `remyral-subtasks_*` (the master decides, as for the other runtimes); requests are size-capped, zod-validated,
at most 8 in flight. 1.19.0 applies the local server's `timeout` to tool calls too, so it is `maxWaitSec + 120 s` (a
75 s call verified). Not offered behind a wrapper command (`commandArgs`). Verified with the real binary
(`opencode-subtasks-real.test.ts`) and inside the unchanged job Seatbelt profile
(`apps/worker/test/opencode-subtasks-seatbelt.test.ts`); Linux bubblewrap, Windows per-job accounts and containers use
the same mechanism but are UNVERIFIED-LIVE. Needs a worker release.

_Superseded text (kept for the record):_ OpenCode had no tool channel the platform controls inside a job. Custom tools come only
from plugins or MCP servers (docs/compat/opencode.md §9a). Plugins are code inside the OpenCode process; the job
adapter forces `plugin: []` and refuses workspaces with a project `.opencode/` config
(`packages/agent-adapters/src/runtimes/opencode/adapter.ts`, `configContent` / `start`; compat §6.5). The only proven
path is the ops-chat one — a per-session loopback MCP endpoint (`src/assistant-mcp-http.ts`) that OpenCode reaches as a
`remote` MCP server — and job sandboxes block it: the job egress policy forbids loopback `127.0.0.0/8` / `::1` whatever
the allowlist says (`apps/worker/src/sandbox/network.ts`, FORBIDDEN); the job Seatbelt profile lets OpenCode only
*listen* on loopback (`sandbox/factory.ts` `listenRuntimes`); only the assistant sandbox profile may connect to named
loopback ports (`apps/worker/src/assistant/sandbox.ts`, `REMYRAL_ASSISTANT_LOOPBACK_PORTS`); a container job cannot reach
the host loopback at all. Whether an OpenCode MCP tool call survives a 600 s `wait_subtask` is also unchecked. Needed:
a job-scoped loopback MCP endpoint, a per-port loopback-connect exception in every job sandbox profile (Seatbelt, bwrap,
job user, Windows slots; containers stay unsupported), a `remyral-subtasks_*: allow` permission rule and a real-binary
test including a long call. Until then OpenCode jobs get no tools and the prompt does not mention them
(`offersSubtaskTools` unset) — backlog `p8-subtasks-others` stays open for OpenCode.

## 11. REST and console

| Route | Authz | Notes |
| --- | --- | --- |
| `GET /jobs/:id/integration` | `jobs.read` | the integration of the job as coordinator, member or own job; `{integration: null}` when none |
| `GET /workflows/runs/:id/integration` | `workflows.read` | the run's integration |
| `POST /integrations/:id/cancel {reason?}` | `jobs.cancel` (operator+) | open or `needs_human` → `cancelled`; its current job is cancelled; branch and members stay; audited; 409 `not_open` |
| `POST /integrations/:id/retry` | `jobs.cancel` (operator+) | only `needs_human`; round limits reset; refused when the integration branch moved (409 `not_retryable`); audited |
| `GET /projects/:id/integration-settings` | `projects.git.read` | `{settings, canEdit}` |
| `PUT /projects/:id/integration-settings {mode, order, maxResolutions, maxFixes}` | `projects.git.write` (admin) + step-up | audited `project.integration.update` |

Console: job page and workflow run page **Integration** panel (state, branch → target, head, PR link (https only),
"request the merge in the Changes panel of job X", overlap warnings, branches in order with state / conflict files /
resolution job, verification, round counts, the integration's jobs, log, Cancel / Retry); Project → Repository →
**Integration** settings. All agent / repository text is rendered as text.

## 12. Data (migration 0089, additive)

`projects.integration_mode` (`master` default | `off`), `integration_order`, `integration_max_resolutions` (3),
`integration_max_fixes` (1); `job_subtasks.paths`; `job_artifacts.kind` + `integration`; `integrations` (one per root
job / run + node; state, base / head sha, head job, rounds, verification, PR, warnings, log ≤ 200 entries, the person it
acts for, claim); `integration_branches` (position, member job, verified branch + sha, paths, state, merged sha,
conflict files + details, resolution); `integration_jobs` (every job it created: integrate / resolve / fix / verify,
round). Audit: `integration.start`, `integration.job.create`, `integration.branch.update`, `integration.publish`,
`integration.finish`, `integration.cancel`, `integration.retry`, `project.integration.update`.

## 13. Security review

| Threat | Mitigation |
| --- | --- |
| A worker claims merges it did not do (T-WRK-2) | The pushed branch is verified by git flow (trailer = attempt/epoch, ancestry); the master checks on the remote that the result descends from the integration head and contains every commit reported merged; the report is data. |
| A repository's `.gitattributes` / hooks / filters run code or hide a conflict | Attributes from the empty tree, no hooks / global / system config, no rerere / editor / signing; conflicts are detected by git, never by attributes (tested with `merge=union`). |
| Prompt injection through task texts, conflict excerpts, diffs, test output (ADR-0010) | All fenced as data with fence look-alikes escaped (tested with an injected end marker); resolution / fix jobs get only the coordinator's policy (no secrets, capped limits), their results are verified and limited (resolution: only conflicting files are taken; fix: must build on the integration head). |
| Privilege escalation via the integration's jobs | Created as the person the integration acts for, re-authorised (`jobs.create`) for every job; integration jobs only from the service (kind refused on `POST /jobs`); placement still needs `integration-v1`, git, project allowlists. |
| Unreviewed code reaches the target | Nothing merges automatically: the head job's protected merge (approval, admin + step-up, sha guard) or the provider's protected PR merge; target branch protection unchanged. Members are approved only by the person who approved the merge. |
| The integration branch is rewritten (force) / races | Fast-forward only with an expected value; a moved branch stops for a human; retry refuses a moved branch. |
| Markdown injection in the PR | `mdText` escaping, redaction, length caps. |
| Resource / cost runaway | Bounded rounds (≤ 10 resolutions, ≤ 5 fixes, defaults 3 / 1), limits capped (1 h agents, 30 min integration step), one integration per root / run node, discovery batch of 5 per tick, the 24 h discovery window. |
| Secrets in reports | Worker redaction + master re-redaction of every report text; pre-push secret scan as for every attempt. |

Residual: GitHub ref updates have no compare-and-swap (re-read right before; the fast-forward rule protects work);
creating a ref that points at commits touching `.github/workflows` needs the App's `workflows: write` permission (not
requested — such an integration stops with the provider's refusal).

## 14. Rollback and operations

Switch a project to integration mode `off` — new coordinators / integrator steps behave as before (per-job PRs, the
integrator agent); open integrations can be cancelled. The migration is additive. Old workers do not advertise
`integration-v1`: integration jobs wait (placement reason `integration_unsupported`, "update the worker"). Operational
signals: integrations by state (`needs_human` count and reasons), round counts, `integration.finish` failures,
placement waits `integration_unsupported`; logs `component=integration`.

Deploy: master (migration 0089) + web; **worker release** (integration step, Codex / Pi sub-job tools, `paths`).

## 15. Tests

- worker `test/integration-step.test.ts` (real git): clean merges with merge commits and identity, contained steps,
  conflict → abort + markers + both diffs, resolution applied for exactly the conflicting files (other changes of the
  resolution ignored), markers left / incomplete resolution refused, `merge=union` ignored, missing commit.
- master unit `integration-model.test.ts` (order: dependency / completion / overlap-last / cycles; ownership overlap;
  prompts fence injected end markers; PR body escaping; protocol refinements), `integration-providers.test.ts`
  (GitHub fixtures for `POST git/refs` / `PATCH git/refs` `force:false` / `PATCH pulls`, plain git create /
  fast-forward / moved / non-fast-forward with real repositories), scheduler placement (`integration_unsupported`,
  runtime not required, git and slots still are).
- master integration `merge-pipeline.test.ts` (real Postgres / Redis / worker daemon / worktrees / pushes, fake runtime,
  fake GitHub PR API): coordinator + 3 sub-jobs (two conflicting, overlapping `paths`) → order, warning, round 1, resolution
  job (prompt carries both sides), round 2, verifier, exactly ONE PR (none for members), protected merge → merged,
  members SUCCEEDED, audit; failing tests → one fix job → `needs_human`, cancel / retry rules, settings API with step-up;
  workflow integrator → master integration, the integrator's agent job cancelled, protected merge → run succeeded.
- adapters / worker (Codex, Pi tools, `paths`): see docs/compat/codex.md §12, docs/compat/pi.md §13.
- web `integration-panel.test.tsx` (panel, hostile text, cancel / retry, settings with step-up, workflow run view).

## 16. UNVERIFIED / open

- **Live:** a GitHub-connected repository project (cluster-test) with a Claude Code coordinator delegating two
  sub-jobs (one Codex) → integration → ONE PR on github.com → merge. Needs the master + worker release deployed and a
  project with a GitHub App installation; steps in the p11 report.
- GitHub `PATCH git/refs` / `POST git/refs` / `PATCH pulls` are fixture-tested only (like the rest of the GitHub path).
- OpenCode sub-job tools (§10).
- A real model choosing the Codex / Pi tools; Linux / Windows runs of the integration step (git behaviour is the same;
  the tests run on macOS and Linux CI).
