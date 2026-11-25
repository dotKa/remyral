# Design note: result reuse — offer an identical earlier result before dispatch (P6)

- **Status:** Implemented
- **Date:** 2026-10-16
- **Backlog:** `p6-result-reuse` ([p6-efficiency.md](p6-efficiency.md))
- **Builds on:** [p5-composer.md](p5-composer.md) (submission, placement preview), [p5-ops-chat.md](p5-ops-chat.md) (draft
  cards), [p6-automations.md](p6-automations.md) (ADR-0024), [p4-dag.md](p4-dag.md) (workflow steps),
  [p4-git-flow.md](p4-git-flow.md) (base at job start), [p6-quota-scheduling.md](p6-quota-scheduling.md) (the runtime an
  attempt actually ran with).
- **Decisions applied:** ADR-0010 (untrusted sources are never trusted for anything sensitive), ADR-0004 (immutable job
  spec), p5-rbac (project visibility). No new ADR: the feature adds read-only lookups, two opt-in policies and links; no
  new trust boundary.

## 1. Problem

The same work is submitted again: a cron automation re-runs a report whose inputs did not change, a user re-submits
a prompt after closing the tab, a workflow's first step does the same research on every run. Each repeat costs a
runtime slot, minutes and tokens. The cluster already knows the earlier result; it should **say so** before running
again — and never decide silently that a result is "the same".

## 2. What "identical" means

A recent job is identical to a draft when all of the following hold:

| Fact | Draft side | Earlier job side |
| --- | --- | --- |
| Project | the draft's project | the same project (never another) |
| State | — | `SUCCEEDED`, finished (`state_changed_at`) within the window |
| Runtime | `spec.runtime` | `spec.runtime`, and the final attempt ran with it (`runtime_choice` absent or index 0 — not a fallback) |
| Model profile | resolved now exactly as submission would (named, routing rule, project / global default) | `spec.modelProfile.id` and its model string (`COALESCE(modelProfile.model, model)`) |
| Prompt | `promptDigest(spec.prompt)` | `jobs.prompt_digest` |
| Repository job | repository URL and the **base commit** the job would start from now | same URL, `job_git.base_sha` = that commit, and the same `baseRef` (or that very commit) |
| Workspace job | `inputsDigest` of the input files it would get, and the project's egress mode / allowed hosts now | `jobs.inputs_digest`, `spec.workspace.egress` / `allowHosts` |
| Trust | `sourceTrust: trusted` | `sourceTrust: trusted` |
| Kind | not machine-admin, no site bundle, no pull request checkout | same, and the job had **no upstream dependencies** |

Digests (`apps/master/src/reuse/digest.ts`, pure, versioned `v1`):

- **prompt:** Unicode NFC, lower case, every whitespace run → one space, trimmed; `sha256:` of `remana-prompt-v1\n` +
  that text. "Fix the README" ≡ " fix   the\nreadme"; punctuation and wording differences are different prompts.
  Case-folding can merge prompts that differ only in an identifier's case — acceptable because the result is only
  ever *offered* (or reused under an explicit policy) and the offer names what matched.
- **workflow steps:** the step prompt contains the run id (header and `{{run.id}}`); it is masked (`{run}`) before
  digesting so runs of the same step can match. The header still names the workflow, step id and role, so a step
  only matches the same step of the same workflow.
- **inputs:** `sha256:` over the sorted `(name, sha256)` pairs (content and name; not upload order or source).
  Workspace jobs always get one (an empty list has its own digest). The browser computes the sha256 of uploads it
  would send (`crypto.subtle`); continued artifacts are resolved by the master.

**Base commit** (`GitFlowService.resolveBaseCommit`): a 40/64-hex `baseRef` is its own commit; a target-branch name is
resolved with the project's git provider (`branchHead`) — the same value git flow captures as "base at job start" when
the earlier job was dispatched. No git provider, another repository than the project's, a non-target ref or a provider
error → `base_unknown`, and the job is never matched. Known gap: the worker checks out `baseRef` slightly after the
master captured its head; a push in between makes the recorded base older than what ran (already true for git flow's
verification).

Not compared, by design: sandbox profile, approval policy, limits, requirements, priority, work branch, the context
bundle (project memory, skills) and secret references. They change *how* a job runs, rarely *what* it produces; the
person (composer, chat) or the opted-in policy decides. Documented on the automation form.

## 3. Data (migration 0055, additive)

- `jobs.prompt_digest`, `jobs.inputs_digest` (`sha256:<hex>`, NULL for older jobs — never matched) + partial index
  `jobs_reuse_idx (project, prompt_digest, state_changed_at DESC) WHERE state = 'SUCCEEDED'`. Written by
  `JobStore.create` for every new job; internal callers may pass `promptDigest` (workflow steps) — never from an HTTP
  body.
- `automations.reuse_within_hours` (1–168, NULL = off) and `automation_runs.reused_job_id` (only on `skipped` runs).
- `workflow_nodes.reused_job_id`.

Rollback: revert the code; the columns are ignored by older code (older masters never fill the digests, so a later
re-deploy simply has fewer candidates).

## 4. Surfaces — never silent

| Where | What happens |
| --- | --- |
| Composer | On **Submit** (job, "now"), the console calls `POST /jobs/reuse-check` with the spec it would submit (and its files' digests / continue-from job). A match shows "An identical job finished 2 h ago." with what matched and **Open result** (link to the job) / **Run anyway** (submits). Any draft change withdraws the offer. A failed check never blocks submission. Window: 72 h. |
| Chat (`draft_job`) | The master checks when the draft is made; the card says "An identical job finished successfully … Open result — or confirm to run it anyway." and the assistant's tool result carries `identicalResult` so it can tell the user. Confirming still creates a new job (the payload's `reuse` is informational and covered by the payload hash). |
| Automations (job targets) | Opt-in policy "Skip a run when an identical job succeeded recently — within N hours" (default off; workflow / deploy targets refuse it: `reuse_job_targets_only`). A matching scheduled run is recorded `skipped` with `reused_job_id`, the reason "Skipped: an identical job succeeded … (job …); reuse policy: within N h." and an `automation.fire` audit event with `skipped: identical_result`. Never applied to **Run now**, untrusted runs, or GitHub / webhook / chain runs (their event data is part of the job's input; schedule runs carry only their due time). |
| Workflow steps | Opt-in `reuseWithinHours` in the definition's `defaults` or on a node (node wins). Only for root steps (no upstream outputs) that are not integrators, dynamic planners, deploy or site-bundle steps. At release, a match cancels the step's own (still blocked) job, points the node at the earlier job (`job_id = reused_job_id`), audits `workflow.step.reuse`, and the step succeeds with that job's outputs; the run view says "Reused the result of identical job …". |

`POST /jobs/reuse-check` — body `{project, spec, inputs?: [{name, sha256}], continueFrom?}` → `{match: {jobId,
finishedAt, age, runtime, modelProfile, baseCommit} | null, reason: untrusted_source | not_eligible | base_unknown |
no_match | null, windowHours}`. Authorization `jobs.create` on the body's project (operator+, like the placement
preview), no side effects, nothing audited.

## 5. Privacy and authorization review

| Concern | Mitigation | Residual |
| --- | --- | --- |
| Learning about other projects' work ("does someone else run this prompt?") | Lookups are scoped to the draft's project in SQL; the route needs `jobs.create` there (404 when the project is not visible) and re-checks `jobs.read` before returning a match. No cross-project match exists. | An operator learns that an identical job exists in their own project — they can already list its jobs. |
| Confirming the prompt of a hidden job by guessing | Same project only; operators of a project can read all its jobs anyway. Viewers cannot call the check (403). | — |
| Untrusted source poisoning a trusted result | Drafts whose source is not `trusted` are not looked up (`untrusted_source`; absent = untrusted); only `trusted` earlier jobs are candidates; pull request heads and automation runs from untrusted sources never reuse. A result produced from untrusted code can never be offered as a trusted one. | — |
| Silent reuse | Composer and chat only offer; automations and workflow steps only with an explicit, default-off policy written by an operator of the project (automation changes need a step-up; workflow definitions are versioned), and every skip is recorded on the run with a link and audited. | — |
| Stale result (code moved on) | Repository jobs match only on the same base commit, resolved now; unresolvable → never matched. Workspace jobs on the same input bytes and egress. | Context bundle and skill changes are not compared (§2). |
| Data exposure in the check | The response carries ids, times, runtime, model profile id and base commit only — no prompt, summary or artifact. The prompt is compared as a digest; digests are not returned. | Digests in the DB are unsalted sha256 of normalised prompts (guessable for short prompts) but are only readable by DB administrators, who can read the prompts anyway. |
| Workflow step reusing another run's job | Same project, same workflow step (header in the digest), root steps only; the earlier job is read-only (terminal) — cancellation or retries of the new run never touch it. | The reused job's branch feeds downstream steps of the new run (as it would have, had the step run). |
| Abuse / cost of the check | One indexed query (partial index), at most one git provider call; behind the normal request budgets. | — |

## 6. Tests

- `apps/master/test/unit/result-reuse.test.ts`: normalisation (case, whitespace, NFC), workflow run-id masking,
  input digests (order-independent, name and content), age wording.
- `apps/master/test/integration/result-reuse.test.ts` (real Postgres, fake git provider): digests recorded at
  submission; check matches case/whitespace variants with base commit; no match on other prompt / runtime / model /
  moved base; `base_unknown` for another repository; pinned SHA bases; untrusted and absent trust refused; viewer 403,
  invisible project 404, no cross-project match; dependent jobs and the window; workspace input digests (order, content)
  and inputs refused on repository projects; the chat draft states the match; the automation policy skips a cron run
  with link, reason and audit, Run now still runs, workflow targets refuse the policy, default off; the workflow step
  policy cancels the own job, reuses the earlier one, the run view and audit show it.
- `apps/web/test/composer.test.tsx` (Identical result): offer shown before submitting with Open result / Run anyway,
  nothing submitted until Run anyway, the check carries the spec; a draft change withdraws it; a failed check submits.
- `apps/web/test/result-reuse.test.tsx`: parsing and wording, browser sha256, the chat card's line (job ids only),
  the automation form's policy, run and workflow-step links.

## 7. Operations and rollout

Master-only (migration 0055); no worker release, no protocol change, no env or Traefik change. Signals: audit
`automation.fire` with `skipped: identical_result`, `workflow.step.reuse`; `automation_runs.reused_job_id`. Only jobs
created after the deploy carry digests, so offers start appearing as new jobs succeed.

## 8. UNVERIFIED

The base-commit resolution against a real GitHub App / plain git remote is exercised through the same provider
`branchHead` call git flow uses (covered there); the reuse tests use a fake provider. The first live offer on a
repository project should show the expected base commit in the composer's notice.
