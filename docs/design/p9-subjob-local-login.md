# Design note: `p9-subjob-local-login-deadlock` — sub-jobs beside their parent on a subscription login

- **Task:** `p9-subjob-local-login-deadlock`. **Date:** 2026-10-17.
- **Decision record:** [ADR-0034 addendum 2](../adr/0034-windows-per-job-accounts.md) (amends decision 7 of the first
  addendum); related ADR-0031 (sub-jobs), ADR-0033 (queue classes), design
  [p9-windows-host-isolation §9.3](p9-windows-host-isolation.md), [p9-queue-priority §12](p9-queue-priority.md).
- **Migration:** none. **Protocol:** additive (`CAPABILITIES.localLogin.stores`, ASSIGN_JOB `execution.family`,
  `SUBTASK_STATUS` `queued` + `reason: blocked_by_parent`). **Worker release needed:** yes (master-only deploy gives
  `blocked_by_parent`, the per-store / family placement needs the new worker report).

## 1. Live finding (prod, 2026-10-17, Windows worker 1.0.34)

Project *genel*: sub-jobs on, delegation runtimes `claude-code`, `codex`. A Claude Code job (subscription login,
`local-login`) called `request_subtask(runtime: codex, requires: [image-generation], wait: true)`. The Codex child (also
`local-login` on that machine) stayed queued with `subscription_login_exclusive` ("Claude Code / Codex subscription
logins run one at a time …") while the parent waited for it — a deadlock until the parent's `wait_subtask` budget ran
out (540 s per call, and the agent called it again).

Two earlier rules combine into it:

1. p9-windows-slots-local-login (ADR-0034 addendum 1): with per-job Windows accounts (`job_user`) a `local-login`
   attempt runs **as the worker account, one at a time and alone** — because (a) Claude Code's OAuth refresh broke when
   processes of *different* accounts shared one login store, and (b) T-SBX-4: two attempts as the worker account have
   no filesystem isolation from each other (and a worker-account attempt can read every slot attempt's directories).
2. p9-queue-local-login-accounting: the master holds such jobs up front from `CAPABILITIES.localLogin` (`runtimes`,
   `exclusiveProfiles`).

"Alone" was one global rule for two different reasons. Each reason has a narrower true scope.

## 2. Reason (a) is per login store, not global

From design §9.3 (strings of the pinned CLI 2.1.296 / 2.1.281): Claude Code serialises a refresh with two mkdir locks in
**its own** store (`<config dir>\.oauth_refresh.lock` and the legacy `<config dir>.lock` next to it) and rotates the
refresh token stored there. Codex keeps its ChatGPT login in `.codex` (`auth.json`) and refreshes at `auth.openai.com`;
it never touches `.claude`. Refresh contention can therefore only happen between processes that use the **same** store.

| Store id | Runtime | Paths (Windows / Unix home of the worker account) |
|---|---|---|
| `claude` | Claude Code | `.claude\`, `.claude.json` (+ the legacy `.claude.lock` in the profile root) |
| `codex` | Codex | `.codex\` |
| `opencode` | OpenCode | `.local/share/opencode` |
| `pi` | Pi | `.pi/agent` |

(The same paths as `RUNTIME_LOGIN_PATHS` of the assistant sandbox and `LOGIN_STORE_NAMES` of the Windows store check.)

**Same store, same account?** The live breakage was *cross-account*: slot accounts could not take or break the lock in
the worker's profile root. Two processes of the *same* account do use the mkdir lock correctly (that is how Seatbelt
attempts on macOS — one account — have run in parallel since p3 without a failure). But on Windows the exact failure
sequence of 2026-10-17 is still UNVERIFIED (§9.3 "most likely"), the store was consumed once already, and a refresh that
dies mid-way leaves a consumed refresh token for every process. **Decision: one attempt per login store at a time on
`job_user` workers** (conservative default from the task). macOS (Seatbelt) is unchanged: its parallel same-store use is
established behaviour. Relaxing Windows to the macOS rule is a follow-up once seen safe live
(`p9-windows-same-store-parallel`, not scheduled).

## 3. Reason (b) holds across jobs, not within one job family

A `local-login` attempt on a `job_user` worker runs as the worker account: it can read and write every other attempt's
workspace (slot attempts' directories are ACL'd to the worker too) and another worker-account attempt's files. Between
**unrelated** jobs that is exactly T-SBX-4 and stays forbidden.

A **job family** is a root job and its agent-requested sub-jobs (ADR-0031: `job_subtasks.root_job_id`; depth ≤ 2,
≤ 16 per family). Inside a family:

- every member is in the same project and was created for the same user (the child's creator is the parent's creator,
  re-authorised at request time);
- data flows between them by design: the parent writes the child's prompt and input files, the child's result summary
  and output files are delivered into the parent's inputs, a repository child works on the same repository;
- the child's sandbox profile and source trust are the parent's; its approval policy is the stricter one.

So letting family members see each other's files on the machine adds no new information flow that the family does not
already have through the platform. **Decision: worker-account attempts may run beside other attempts only when every
attempt on the machine belongs to the same family** (and no `unconfined` attempt runs — ADR-0019 keeps that one alone).

### 3.1 Residual risk (documented, accepted)

| Risk | Why acceptable / mitigation |
|---|---|
| A family member tampers with another's working tree or scratch while both run (e.g. the parent rewrites the child's files before the child commits, or the child writes into the parent's worktree) | The parent already decides the child's prompt and inputs and consumes its result; a child already returns arbitrary content to the parent. Pushes stay per attempt (own branch `sub/…`, the pre-push secret scan, the master's remote verification); approvals are still per job. Nothing crosses the project or the user. |
| A stricter-policy child's protections are bypassed through the parent's process (the parent, `allow-all`, modifies files the child would have asked approval for) | The child's approval policy governs the child's tool calls; the parent could do the same work itself under its own policy — delegating does not widen it. |
| Unrelated job reads a family's files | Not possible by this change: any attempt of another family keeps the exclusivity (placement + `selectProfile`). |
| The family id is wrong | It comes from the master (ASSIGN_JOB, authenticated channel), derived from `job_subtasks`; a worker without it treats every job as its own family (the old rule). The worker additionally requires the same project id. |
| Both runtimes' login stores of one account are readable by both attempts | Already true for every worker-account attempt (one account owns both stores); no change. |

## 4. The rule (worker `selectProfile` = enforcement point; master placement mirrors it)

Only for host profiles on a worker with per-job Windows accounts (`filesystemConfinement: job_user`). Terms: an attempt
is *login* when its auth is `local-login` (it runs as the worker account), *slot* when it is a host attempt that holds a
per-job account.

- **New login attempt N** may start iff no `unconfined` attempt runs, **every** running attempt belongs to N's family,
  and no running login attempt uses N's login store. Otherwise a transient refusal that says which: *"waiting for the
  Claude Code subscription login on this machine to be free"* (same store) or *"the machine is running another job"*
  (other family).
- **New slot attempt N** (API key): while any login (or unconfined) attempt runs, it may start only when every running
  attempt belongs to N's family (and none is unconfined); then the usual per-job account limit.
- Unchanged: `unconfined` alone; `none` (no confinement) one at a time; Seatbelt parallel.

Worker data: `ActiveJob` carries `family` (ASSIGN_JOB `execution.family.rootJobId`, else its own job id) and the project
id; `selectProfile` receives `attempts: {family, project, profile, authMode, loginStore}[]` and the job's own
`family` / `loginStore`. Without `attempts` (other callers) the old rule applies.

Master data: `CAPABILITIES.localLogin.stores` (runtime → store id) — its presence means the worker applies §4. Each
slot-holding lease carries its job's family (`job_subtasks.root_job_id`, else the job id); `PlacementJob.family` the
same for the job being placed. Workers without `stores` keep the old, global rule.

### 4.1 Wait reasons

| Code | When | Text (EN; TR in the console) |
|---|---|---|
| `subscription_login_busy` (new, transient) | a login job and a running login job share the store | "waiting for the Claude Code subscription login on <machine> to be free: one Claude Code job at a time uses it (shared login; n running)" |
| `subscription_login_exclusive` (kept) | the machine runs another family's job (login job), or another family's login job runs (any job of those profiles) | "<machine> is running another job; a Codex subscription-login job runs as the worker account, so it starts when the machine is free or runs only its own parent / sub-jobs" |

Both are transient, `BUSY_CODES` (no fallback switch), queue category *Subscription login*.

## 5. `blocked_by_parent` — no deadlock by waiting, generically

Even with §4 a child can be stuck behind its own waiting parent: same store (Claude Code parent → Claude Code child on
a one-machine fleet), a machine with `maxParallelJobs: 1`, an exclusive profile (`none`), an old worker without
`stores`. The parent's `wait_subtask` then burns its budget.

When the parent asks for a sub-job's status (`status` op — every 3 s while `request_subtask(wait)` / `wait_subtask`
waits) and the child is QUEUED with schedule status `waiting`, the master checks:

1. the parent holds a slot-holding lease on machine P;
2. no machine is eligible for the child now, and every machine other than P excludes it for a **permanent** reason;
3. on P, with the parent's lease taken out of the facts (counterfactual), the child **would be** eligible.

Then the answer is `state: queued, reason: blocked_by_parent` with a detail naming the machine and the reason ("This
sub-job can only run on DESKTOP-…, and there it waits for this job itself (…). Do this part yourself (and
cancel_subtask …), or finish without it"). The worker's tool host stops waiting at once on that answer and returns it
to the agent (`ok: false`). The child stays queued (the agent may cancel it; it is cancelled by the cascade when the
parent ends anyway). An old worker keeps polling until its wait budget, but now sees the detail when it returns.
Because the parent's machine frees up a moment before the cascade tick runs, dispatch now skips a QUEUED sub-job whose
parent already ended (the cascade cancels it) — otherwise the child the agent decided to replace would start briefly.

Checked on demand (each status poll; one candidates query, only for QUEUED children in `waiting`). False negatives are
harmless (the old wait); a false positive is impossible by (3) unless the facts change in the next seconds — the agent
can still `wait_subtask` again.

## 6. Queue screen

Pool header: "subscription logins: 1 at a time **per login**" when the worker reports `stores` (`perLogin: true` on
`subscriptionLogins`), else as before.

## 7. Security review

- **Credential stores:** unchanged ACLs; no slot account gets a store. Two worker-account processes of different
  runtimes use different stores; the same store is never used twice at once on Windows.
- **Isolation:** relaxed only inside a family (§3, residual risks listed). Unrelated jobs: unchanged T-SBX-4 behaviour.
  `unconfined` never shares.
- **Trust of inputs:** the family id is master-derived (not agent-controlled: `job_subtasks` rows are written by the
  master on a lease-fenced request); the worker never trusts a family id over a different project id. A worker's
  `stores` report only relaxes its own placement (the worker enforces anyway); values are schema-validated (known
  runtimes, short ids).
- **blocked_by_parent** reveals to the agent the machine name and the scheduler's reason text (no secrets; the same
  text the job page shows to the user who owns both jobs).
- No new privileged path, no migration.

## 8. Tests

- Scheduler (`packages/scheduler/test/subjob-local-login.test.ts`): family/store matrix — parent Claude login + child
  Codex login placed; unrelated Codex login waits (`subscription_login_exclusive`); same store waits
  (`subscription_login_busy`, also inside the family); API-key family member beside a family login; unrelated API-key
  waits; legacy (no `stores`) unchanged; `withoutJob` counterfactual.
- Master unit (`apps/master/test/unit/subjob-local-login.test.ts`): `localLoginFacts` with `stores`, `slotCounts` /
  `withoutJob`, wait category of the new code.
- Master integration with real worker daemons (`apps/master/test/integration/subjob-local-login.test.ts`): Claude Code
  parent (local-login) + Codex child (local-login) run concurrently and the parent gets the child's result; two
  unrelated local-login jobs of different runtimes serialise; two same-store jobs serialise
  (`subscription_login_busy`); Claude Code parent → Claude Code child gets `blocked_by_parent` within seconds.
- Worker (`apps/worker/test/subjob-local-login-policy.test.ts`): `selectProfile` family/store matrix, unconfined, old
  rule without `attempts`, macOS unchanged; `profileSlots` reports `stores`; the tool host stops on
  `blocked_by_parent`.
- Protocol: `stores`, `execution.family`.

## 9. Deploy and rollback

Master first (gives `blocked_by_parent` and the new codes; workers without `stores` keep the old rule), then a worker
release (adds `stores` and the family rule). Rollback: previous master or worker; without `stores` the old global rule
returns. UNVERIFIED-LIVE: a Claude Code parent and a Codex child running at once on win-1 (both on the
subscription login, as the worker account).
