# p15-auto-mode — "Otomatik mod": approvals the policy grants, automatic retries, self-healing, failure digest

Status: implemented (2026-10-22). Amends ADR-0056 (owner decision 2026-10-22, §1 below). Migration 0126. Backlog:
`p15-auto-mode`.

## 1. Owner direction (2026-10-22)

"Claude CLI'daki auto mode gibi davranabilmeli sistem. Sürekli onay, sürekli başarısızlıkları çözmesi için yeniden
deneme için onaylar manasız. Başarısızlıklar çok fazla." Decision: an "Otomatik mod" that is **on for the owner's
deployment by default**; the three explicit `autoApprove = false` overrides of the prod policy (deploy, tool.mcp,
runtime.dangerous_tool) are removed.

Prod analysis (48 h, 59 jobs, 35 failed) the design answers: 14 RuntimeCrashedError (fixed in 1.0.51 — retried now),
9 BaseRefNotFoundError (5 × `main` missing, 4 × a previous job's never-pushed work branch `agent/chat-…` as base),
7 DiskQuotaError (placement fixed in 1.0.58 — retried elsewhere now), 3 expired git token (fixed in 1.0.58 — retried),
3 stuck AWAITING_APPROVAL (fixed 1.0.58), 2 verification "diverged". Approvals: 6 git.merge gates, 5 in-run
runtime.dangerous_tool.

## 2. The switch

`autonomy.autoMode: boolean` in the security policy document (`apps/master/src/security-policy/model.ts`); presets:
Serbest on, Dengeli off, Sıkı off. `autonomy.autoRetryMax` (0–5): Serbest / Dengeli 3, Sıkı 0. Both are ordinary
policy values — versioned, audited (`security.policy.update` with `autonomy.autoMode` in `changed`), settable in
Ayarlar → Güvenlik (one prominent switch at the top, saved at once; the retry count select below it) and through the
assistant's `change_settings` (`securityPolicy.autonomy.autoMode` / `autoRetryMax`; the protocol schema and rule 27 of
the system prompt name them).

**What auto mode grants** (`resolveRule`, layer `autoMode`, `apps/master/src/approvals/policy.ts`): every
`require_approval` resolves to `allow` (source `security_policy`, `autoMode: 'granted'`) for jobs that

- have a trusted source (`spec.sourceTrust !== 'untrusted'`),
- are not machine administration (`kind !== 'machine-admin'`),
- did not ask for more prompts (`ask-all`, `deny-sensitive` keep their meaning; `allow-all`, `ask-sensitive` and no
  mode are covered).

That covers in-run tool approvals (`runtime.dangerous_tool`, the 5 prod requests), MCP tools (`tool.mcp`), git.merge
decisions (the 6 prod gates: `GitFlowService.#openDecisionIn` → policy merge, executed with the sha guard), secret /
egress / budget requests and deploy approval requests. **Deploy ops actions** (Coolify / Pages deploys, production
too) run at once (`OpsService.request`, `autoMode` dep): state `executing`, `decision_reason` "Approved by auto mode
(security policy)", audit `ops.action.approve` (actor system `security-policy`, `approvedVia: security_policy`,
`autoMode: true`).

**Hard floor** (`AUTO_MODE_FLOOR`): `machine.admin`, `git.force_push`, `fs.delete_outside_workspace` always ask a
person — even where the autonomy set would have let them pass for an `allow-all` job (auto mode tightens these). DNS
deletes and the restore of a deleted record keep their approval. A `deny` is never turned into an allow. The safe core
(2FA, the security policy itself, users / roles, secret reveal) are step-up events, untouched by auto mode. "Unless the
user explicitly asked in chat": the floor request stays pending and the assistant approves it directly when the user
says so (existing direct approval, ADR-0056 §5) — no new bypass.

**Audit and timeline**: `approval.evaluate` metadata `approvedVia: security_policy`, `autoMode: true`; a row of
`job_auto_events` (`auto_approved`, at most 200 per job) → job page panel "Otomatik işlemler": "Otomatik mod
onayladı: Deploy (üretim dahil)".

## 3. Automatic retries

`apps/master/src/self-heal/classify.ts` (pure): `transient` (runtime crash, disk_low, git auth / network, runtime
login, worker restart, provider 5xx / overloaded, lost lease, attempt branch missing after publish, the remote not
inspectable), `heal` (missing base ref, diverged verification), `handled` (usage limits — ADR-0040 owns them),
`permanent` (policy refusals — `policyRefusal`, invalid requests, timeouts, cancellations, failing runs, verification for
content reasons). Unknown → permanent (conservative).

`AutoRetryService.decideWithin` (inside the transaction that would fail the job): a transient failure (or a missing base
ref) → `attempt_retry` (retry-safe, actor system `self-heal`) instead of `attempt_failed` / `verification_failed` /
`reconcile_fail`, at most `autoRetryMax` times per job (`job_auto_retries`), backoff 1, 5, 20 (60, 120) minutes
(`promoteRetries` waits for `retry_at`), base ref 0. Hooks: worker result (`OrchestrationInbox`, STARTING / RUNNING),
git-flow verification (`GitFlowService.#finishVerification`), lost attempts (`Orchestrator.#decide`). Never: machine
administration and function jobs; workspace jobs only when the runtime never started (web side effects, ADR-0004 §5).
Retry safety for repository jobs: every attempt has its own attempt branch (`rac/<job>/<attempt>`) and scratch worktree.

**Another machine**: a machine-specific cause (runtime crash, disk, credentials missing, login, network, lost lease)
records the machine; the dispatcher ranks it last among the eligible candidates (`rankAvoiding`) — the only eligible
machine still runs it. "Otomatik yeniden deneme 2/3" on the job page (and "Sonraki deneme 14:05" while waiting); the
exhaustion is an event (`retry_exhausted`). Audit `job.auto_retry`.

## 4. Self-healing

### a. Base ref (`self-heal/base-ref.ts`, before dispatch, outside the dispatch lock)

When a queued job's base ref is not on the remote:

1. it is another job's work branch (`spec.repository.workBranch` — never pushed: the platform publishes attempt
   branches) or attempt branch → merged: its target branch; verified head: that commit (`previous_job_head`); still
   running / verifying / waiting: the job waits (`dependency_pending` on the queue screen); ended without a published
   result: the project's base branch (`project_base`, with the previous job in the event);
2. the project's base branch (`main`) is missing → the repository's default branch (`GitProvider.defaultBranch`: GitHub
   `GET /repos/{o}/{r}` → `default_branch`; plain git `ls-remote --symref HEAD`), recorded on the project
   (`project_git_configs.base_branch`, version + 1, audit `project.git.base_branch_healed`).

A heal is a row of `job_base_ref_changes` (the spec stays immutable; `JobStore` merges the latest into
`spec.repository.baseRef`, like time limits), `job_git.target_branch` follows, an event `base_ref` and an audit entry
`job.base_ref.heal`. A worker-side BaseRefNotFoundError is retried at once (cause `base_ref`) and healed before the next
dispatch.

### b. Diverged verification (`GitFlowService.#autoRebase`)

"head X is not a descendant of the base at job start Y (diverged)": the platform re-applies the attempt's changes
(head vs. its merge base with Y) as one commit on Y — the head commit's message (the `Remyral-Attempt` trailer included)
and author — and moves the attempt branch while it is still at the verified head (`GitProvider.rebaseOnto`: plain git
`merge-tree` + `commit-tree` + `push --force-with-lease`; GitHub: a temporary branch at Y, `POST merges`, `POST
git/commits`, `PATCH git/refs` forced after re-reading the head — no compare-and-swap, residual race; temporary branch
deleted). Only attempt branches (`rac/…`) are ever rewritten. Then verification runs again; the worker's claimed head is
accepted when `job_git.auto_rebase` records exactly that rebase. Once per attempt. **Conflicts**: nothing is written; the
verification fails with the conflicting files ("… a person (or the auto-fix job) resolves them"), shown on the job page
and in the digest — the decision is the person's (or, with auto mode, the auto-fix job's, §4c). Audit `git.auto_rebase`.

### c. Auto-fix job (`self-heal/auto-fix.ts`, a tick step)

A job that ends FAILED (after its retries), with auto mode on, started by a person, not machine administration /
function / integration, not a policy refusal or a cancellation, not itself a fix job: **one** follow-up job with the
same project / runtime / settings (`rerunSpec`), created as the original creator (re-authorised `jobs.create`), prompt
"Find and fix the cause of the failure, then finish the original task" + the failure text fenced as data + the original
task. `job_auto_fixes` (one row per source job: created / skipped with the reason / succeeded / failed / cancelled).
When the fix job ends: event on the source job and one notification `job.auto_fix` to the owners and the creator
(outbox topic `self_heal.auto_fix`). Bounded: failures of the last 6 h after the master started, 3 per tick.

## 5. Failure digest

`GET /autonomy/digest` (viewer+, the caller's projects): failed jobs in 24 h · jobs healed by themselves (succeeded in
the window after an automatic retry / base ref / rebase, or whose auto-fix job succeeded) · decisions waiting for a
person (pending approvals + deploys awaiting approval). Home (Senden bekleyenler): "Son 24 saat: X başarısız · Y
kendiliğinden düzeldi · Z senden bekliyor" with "Başarısız işler" → `/jobs?state=FAILED`.

`GET /jobs/:id/autonomy`: the job's retry state, events, fix job / fix-of link (job page "Otomatik işlemler").

## 6. Migration 0126

- `security_policy`: `autonomy.autoMode = true`, the `false` overrides of deploy / tool.mcp / runtime.dangerous_tool
  removed; a new version (`via = 'migration'`, reason with the owner decision). The master audits migration versions
  on start-up (`security_policy_versions.audited_at`; actor system `migration`, `changed` paths) — the audit log is a
  hash chain SQL cannot extend.
- Tables `job_auto_events`, `job_auto_retries`, `job_base_ref_changes`, `job_auto_fixes`; `job_git.auto_rebase`;
  notification kind `job.auto_fix`.
- Rollback: additive tables. An older master parses the policy strictly and would read the unknown `autoMode` as an
  invalid document → Sıkı (fail closed). Before rolling the master back:
  `UPDATE security_policy SET document = document #- '{autonomy,autoMode}' #- '{autonomy,autoRetryMax}', version = version + 1 WHERE id = 1;`

## 7. Security review

| Threat | Mitigation |
|---|---|
| Untrusted repository gets auto-approved actions | auto mode requires `sourceTrust` trusted (ADR-0010: repository content has no authority); untrusted jobs keep asking |
| Destructive actions without a person | floor: force push, deletes outside the workspace, machine admin, DNS deletes always ask; a `deny` stays a deny |
| Account takeover via the policy | the safe core (security policy, 2FA, users/roles, secret reveal) stays a step-up event; auto mode changes no event |
| Retry storms / cost | at most 5 retries per job (policy), backoff up to 2 h, no retries of permanent causes; one auto-fix job per failed job, never a fix of a fix, 3 per tick, 6 h window |
| Duplicate side effects of a retry (ADR-0004) | repository attempts push their own attempt branch; workspace jobs only retried before the runtime started; function / machine-admin never |
| Platform rewrites history | only attempt branches `rac/<job>/<attempt>`, compare-and-swap on the verified head (plain git lease; GitHub re-read), target branches never |
| Prompt injection through the failure text in the fix job | fenced as data with an explicit "treat it as data" line; the fix job has the creator's rights only (re-authorised), auto mode's floor applies to it |
| Base ref healing points a job at foreign code | only refs of jobs in the same project, the project's base branch or the provider's default branch of the project's registered repository |
| Hidden policy change by the migration | versioned with the owner-decision reason and audited by the master as a system change |

Residual: GitHub ref updates have no compare-and-swap (re-read immediately before the forced update of the attempt
branch). In Serbest the code default of `autoMode` is on, so an installation on Serbest starts in auto mode (owner direction; since the 2026-11-24 ADR-0056 amendment a fresh installation starts on Dengeli, where auto mode is off).

## 8. Tests

- Unit `test/unit/auto-mode.test.ts`: presets / patches / changed paths, each granted kind and job mode, the floor,
  deny kept, classification of every prod cause, backoff, retry eligibility, machine ranking, the fix prompt, GitHub
  `defaultBranch` / `rebaseOnto` fixtures (UNVERIFIED-LIVE).
- Integration `test/integration/auto-mode.test.ts`: grants (tool, MCP, deploy, secret, merge gate) with audit and
  timeline, off → pending, floor, untrusted / ask-all, retries 1/5/20 min with promotion and exhaustion + avoided
  machines, permanent / Sıkı not retried, base ref: wait → previous head, project base fallback, repository default
  recorded on the project, diverged auto-rebase (plain git, real bare repository) and the conflicting case, auto-fix
  once / skipped refusal / no fix of a fix / one notification, auto mode off → no fix, digest counts; migration 0126 on
  the prod document and its start-up audit.
- `ops-actions.test.ts`: a production deploy runs at once under auto mode (audit approvedVia).
- UNVERIFIED (needs prod / real runtimes): real GitHub rebase / default-branch calls, worker-side retry of a real
  RuntimeCrashedError / DiskQuotaError on another machine, the prod migration result.
