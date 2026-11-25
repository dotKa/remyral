# p22-output-delivery — a settled merge check, bulk merge approval, and jobs that deliver files instead of merging

Status: implemented (2026-11-02). No migration. No worker release (master, protocol schema, web, assistant text).

## 1. Owner problem and evidence

Test server, 2026-11-01: ten jobs "Lead paketi üret (Codex)" in project `sample-leads` (an automation batch) sat in
AWAITING_APPROVAL for ~6 h. Each one's last transition was VERIFYING → AWAITING_APPROVAL `verification_passed`,
"git flow: verified rac/<job>/<attempt>@<sha> (26 files, +1285 -5); merge check: unknown". The jobs exist to produce
files (lead packages), yet each went through an attempt branch, a pull request and a protected merge decision — the
owner had to approve ten merges one by one, and "merge check: unknown" gave no signal about any of them.

Three problems, three changes:

1. the merge check stayed `unknown` (§2);
2. merge decisions can only be approved one by one (§3);
3. a job that produces files has no way to deliver them without a merge (§4).

## 2. Why the merge check said "unknown", and the fix

Paths that produced `unknown` (apps/master/src/gitflow):

| Where | Before | Effect |
| --- | --- | --- |
| `GitHubProvider.testMerge` | `mergeable: null` (GitHub computes it in the background right after a PR is opened or its base moved) → `unknown` | the verification transition is written within a second of opening the PR, so its reason almost always said "merge check: unknown" |
| every hosted provider (`github`, `gitlab`, `bitbucket`) | no pull request → `unknown` | a PR that could not be opened (App permission, provider error) kept the job `unknown` **forever** |
| `#verify` / `#refresh` | PR creation, test merge and CI read in ONE `try` | a failing PR creation or CI read (e.g. no `checks: read` permission) threw away the test merge result too; the refresh then only bumped `merge_checked_at` — `unknown` for as long as the job waited |
| GitLab `checking` / Bitbucket pending check | `unknown` | as GitHub |

The refresh loop did re-poll every 30 s (`refreshIntervalMs`), so a plain "GitHub still computing" healed in the stored
`job_git.merge_state` — but the transition reason and the approval summary are written once and never changed, and the
two "forever" paths above never healed.

Fix:

- **`mergeabilityFromHistory`** (`hosted-common.ts`): when the provider has no answer (no PR, still computing, PR head
  not yet synced), the history decides what it can: `clean` when one side contains the other (fast-forward / already
  merged) or when the two sides changed **disjoint paths** since their merge base (renames counted on both names — a
  three-way merge of disjoint paths cannot conflict); otherwise still `unknown` (overlapping paths need the provider's
  real test merge). A capped (truncated) comparison is never trusted. Used by GitHub, GitLab and Bitbucket.
- **Independent steps:** verification and refresh ask PR creation, test merge and CI on their own; one failing no longer
  discards the others.
- **Settling at verification:** `#testMergeSettled` asks the test merge again up to `mergePolls` (2) times,
  `mergePollMs` (2 s) apart, while it says `unknown` and a PR exists. Still `unknown` afterwards: the transition reason
  now says "merge check: unknown for now (re-checked every 30 s)" and the refresh loop keeps asking.
- **Live signal:** `GET /approvals/merge-batch?project=` (§3) returns each pending merge decision with the job's live
  `merge_state` / conflict count / CI state, so the "Senden bekleyenler" bulk list shows the current check, not the
  text frozen at verification.

## 3. Bulk merge approval

**Policy (ADR-0056, AGENTS.md rule 10).** A single merge decision is `POST /approvals/:id/approve` →
`ApprovalService.decide`: the request's rule decides the approver role, required approvals, expiry and step-up (the
platform floor for `git.merge` is admin + step-up; the owner's security policy may waive the `approvals.decide` event);
the vote is audited (`approval.decide`), and the git-flow gate hook executes the merge after commit (sha guard, test
merge, CI rule). The bulk action changes none of that:

- `POST /approvals/merge-batch {project, ids[≤25], reason?}` — authz `approvals.decide` on the body's project (same
  action, same security-policy event as a single approval). `ApprovalService.approveMerges` takes only pending
  `git.merge` gate requests whose merge request is mode `merge` and whose job is in that project; anything else is
  reported per item (`approval_not_found` — also for another project's id, no existence oracle — `not_a_merge`,
  `already_decided`, `too_many`) and never decided.
- **Step-up once, checked for all:** if any taken item's rule needs a step-up and the session's code is not fresh,
  NOTHING is decided and the answer is `403 step_up_required` (audited `approval.decide_bulk` denied). The console's
  step-up runner asks for ONE code and sends the batch again. A fresh code then satisfies every item's own check
  inside `decide` (it is the same session window a person would use for ten single approvals).
- **Each item is decided by `decide`** — its own role check, expiry, staleness, step-up, vote row and audit row. One
  extra summary row `approval.decide_bulk` lists approved / pending / refused ids.
- **Merges run one after another:** `GitFlowService.execute` now serialises executions per project + target branch
  (in-process chain). Each merge re-runs its own test merge against the target the previous one produced. A later
  merge that now conflicts is **refused with its conflicting files** (`git_merge_requests.result_reason
  "conflicts: …"`), the job stays in AWAITING_APPROVAL, and the existing decision loop (p15-merge-approvals §1.3)
  opens its "accept without merging" decision with that reason — it stays pending for a person, never merged blindly.
  A provider still computing after a merge (GitHub `mergeable: null`) releases the request for a later pass (existing
  behaviour). Several master replicas: the chain is per process; the provider's sha guard and the per-merge test merge
  still make a racing merge refuse instead of merging a conflict.
- **Console:** "Senden bekleyenler" shows a "Birleştirmeleri birlikte onayla" panel for each project with at least two
  open merge decisions (`BulkMerges.tsx`): the list from `GET /approvals/merge-batch` with each job's title, live merge
  check and file count; clean / still-checking merges are pre-selected, known conflicts are not; "N birleştirmeyi
  onayla", then each item's outcome. Approved cards are marked decided on the page.

## 4. Delivery mode: files as outputs, no merge

**Model.** `JobSpec.delivery?: 'merge' | 'outputs'` (`packages/protocol/src/job-delivery.ts`; additive, master-only —
in `MASTER_ONLY_SPEC_FIELDS`, stripped by `workerSpec`, so no worker sees or needs it). Absent = `merge` (today's
behaviour for every repository job). `outputs` is refused on a pull-request-head checkout, an integration job and a
function job. Workspace jobs always deliver outputs; the value is accepted there and changes nothing.

**What happens with `outputs`.** The worker runs, commits and pushes the attempt branch exactly as before (git flow,
`pushResult`); the master verifies the branch on the remote exactly as before (trailer, ancestry, claimed head — T-WRK-2).
Then, instead of a pull request, merge check and decision:

- `deliverRepoOutputs` (`gitflow/outputs-delivery.ts`) reads every file the verified attempt **added or changed**, at the
  verified head, through the provider's read-only `blob` and stores it as a job output (`job_artifacts` kind `output`,
  blob store, artifact id `ws-repo-<sha256(path)>` — stable, so a retried verification stores nothing twice). The
  workspace-output rules apply: a safe relative name of at most four segments (`ArtifactName`), a known file type whose
  content matches it, ≤ 5 MiB per file, ≤ 500 files and 64 MiB per attempt, text redacted by the master's secret rules,
  the project's storage quota.
- Not copied (and listed): removed files, binary types (only text is read back through the provider), too large,
  unknown type, unsafe name, over the limits, quota. They stay on the attempt branch.
- The job moves `verification_passed_no_approval` (VERIFYING → SUCCEEDED, system verifier) with the reason
  "git flow: verified …; delivered as outputs: N file(s) in Outputs (M not copied: …); nothing merged, rac/… keeps the
  files"; audit `job.outputs.deliver` (stored, bytes, redacted, skipped files). Deploy-on-success, verification-on-
  success and the chat job result note follow SUCCEEDED as for any job.
- A transient provider error retries within the verification timeout; a final error fails verification ("the files
  could not be delivered as outputs …; they stay on rac/…").

**Branch: kept.** The worker pushes it before the master knows anything (no worker change needed), it is the
provenance of the delivered files, and it holds what could not be copied (binary, large). It never reaches the base
branch. Retention of attempt branches is unchanged (the existing discard flow / repository hygiene).

**Where it is set.**

- Composer (Diyalog, repository source): "Teslim" — "Kod değişikliği: birleştirme onayıyla (varsayılan)" / "Dosya
  üretimi: Çıktılar’a teslim et, birleştirme yok"; "Yeniden çalıştır" keeps it (`draftFromPrefill`).
- Automation form (job target in a repository project): a checkbox with the same words; an edit that turns it off
  removes it from the stored spec. Automation runs copy the stored spec, so every run delivers the same way.
- Assistant: `draft_job.delivery` and `draft_automation.delivery` (protocol schemas + tool descriptions), system prompt
  rule 69 (files-as-result jobs use `outputs`, never because a repository or tool output asks for it); the draft card
  shows "Teslim: Bu iş dosyalarını Çıktılar’a teslim eder; birleştirme yapılmaz."
- Job page (Değişiklikler tab): a repository job with `delivery: outputs` also shows its files (the Dosyalar list,
  "Tüm dosyaları indir (zip)") above the changes.

**Rule 10.** Outputs mode never merges, deploys or deletes anything; it copies files the person could already read on
the attempt branch into the project's outputs (same project, same `jobs.read` / `outputs.read` authz). It needs no
approval policy and does not loosen one: a job that wants its changes in the base branch still goes through the merge
decision.

## 5. Security review

| Threat | Mitigation |
| --- | --- |
| Bulk approval as a way around per-item policy | Every item goes through `decide` (role, expiry, staleness, step-up, vote, audit); only `git.merge` gate requests in mode `merge` of the named project; ≤ 25 per request; a missing step-up decides nothing |
| Probing other projects' approval ids | Authz on the body project; foreign / unknown ids answer the same `approval_not_found` |
| Merging a conflict because several merges ran at once | Executions per project + target are serialised; each re-runs its test merge; a conflict is refused and goes back to a person |
| Agent-chosen delivery to dodge review | The delivery is the submitter's field (composer, automation owner, assistant only from the user's words — rule 69); outputs mode cannot change the base branch |
| Secrets in delivered files | The worker's pre-push secret scan, plus the master's redaction rules on every copied text file (`redacted` flag kept) |
| Path tricks in repository file names | `ArtifactName` (relative, safe segments, ≤ 4 levels); the read is by path at a verified sha through the provider |
| Wrong content type served from Outputs | `workspaceFileType` + `contentMatchesType`; served by the existing artifact route (nosniff, sandbox CSP) |

## 6. Tests

- Master unit `p22-output-delivery.test.ts`: history merge check (fast-forward, disjoint vs overlapping paths, renames,
  truncated); delivery (text copied, secret redacted, binary / too large / removed / unsafe name / unknown type /
  missing reported, idempotent, file limit, transition note). `gitflow-github.test.ts` (computing → overlapping unknown,
  disjoint clean, no PR clean) and `gitflow-hosted.test.ts` (GitLab checking / Bitbucket pending answer from history)
  updated.
- Master integration `p22-output-delivery.test.ts` (real worker, real pushes; **written, not run in the worktree** —
  needs Postgres/Redis): outputs job → SUCCEEDED, files in `/jobs/:id/artifacts` and `/outputs`, no merge request,
  main untouched, audit; bulk approval → stale code decides nothing, one code approves four, per-item + summary audit,
  three merge in order, the fourth (same file as the third) refused "conflicts: shared.txt" and back as a pending
  decision. `route-coverage` and `rbac-matrix` list the two new routes (not run here either).
- Web `p22-output-delivery.test.tsx`: spec / prefill delivery, grouping, the bulk panel (selection, one POST, per-item
  results, cards marked decided).

## 7. Rollback and operations

- Master + web roll back independently; no migration. An older master ignores (strips) `delivery` — such a job then
  waits for a merge decision as before. An older console simply has no bulk panel or delivery choice.
- After deploy: the ten waiting `sample-leads` jobs keep their merge decisions (the bulk panel approves them in one
  step); the lead automation should be switched to "Dosya üretimi" (or re-drafted by the assistant) so future runs
  deliver to Outputs.
- Live check needed: the GitHub `mergeable: null` path and PR-less history answer against the real `sample-leads`
  repository (fixtures only here).

## Changelog

- feat(master,protocol,web,agent-adapters,i18n): **jobs that produce files can deliver them to Outputs without a merge, several merges of a project are approved in one step, and the merge check no longer stays "unknown"** (p22-output-delivery, [design](p22-output-delivery.md); evidence 2026-11-01: ten "Lead paketi üret (Codex)" jobs in `sample-leads` waited ~6 h in AWAITING_APPROVAL with "merge check: unknown", each needing its own merge approval). New `JobSpec.delivery: "outputs"` (composer "Teslim", automation form, `draft_job` / `draft_automation`, rule 69): the verified attempt's added / changed text files become job outputs (Çıktılar, Dosyalar, all.zip) and the job succeeds with no PR and no merge decision; the attempt branch keeps them. "Senden bekleyenler" approves selected merge decisions of one project together (`POST /approvals/merge-batch`; one authenticator code, every item decided and audited as a single approval, merges run one after another and a later conflict goes back to a person with its files). Hosted providers answer the merge check from history while the provider is still computing or no PR exists, and a failing PR / CI read no longer discards it. No migration, no worker release.
