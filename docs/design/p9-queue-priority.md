# p9-queue-priority — decline = wait, per-profile slots, priority classes, urgent reserve, queue screen

Status: implemented (2026-10-17). Owner decisions: the internal note `kuyruk-plani` (not published) §4 (S1 → 5a,
S2 efficiency-first classes, S4 chat urgency, S5 operator/admin reorder). ADR:
[ADR-0033](../adr/0033-queue-classes-and-transient-declines.md). Migration `0071_queue_priority.sql`.

## 1. Problem (production, 2026-10-17)

One Windows worker (desktop-pc, worker 1.0.27, 3 slots). A `host-restricted` job runs; a second host job arrives. The
worker's profile selection refuses it (T-SBX-4: without filesystem confinement concurrent attempts cannot be isolated),
LEASE_ACK `accepted: false`; the master applied `lease_declined` → QUEUED, then placement marked that worker
`declined_before` **permanent** → infeasible → FAILED within ~2 s ("no eligible worker: declined_before"). The master
knew only the total slot count (3), not that the host profile is limited to one attempt.

## 2. Decline = wait (§1 of the task)

- **Protocol** (`packages/protocol/src/queue.ts`, additive in 1.0): `LEASE_ACK.declineKind: transient | permanent`,
  `retryAfterMs?` (≤ 1 h). Workers with `profile-slots-v1` send it with every decline:
  - transient: T-SBX-4 refusals (host / runtime-sandbox without confinement, unconfined) — `retryAfterMs` 5 s (the
    running attempt may be finishing); shutting down, `capacity reached`, `machine_admin_busy`, a previous attempt of the
    same job still running — 15 s.
  - permanent: everything else (lease token, policy, profile missing / not ready, opt-ins, OS, runtime, skills …).
- **Old workers** send no kind: `classifyDecline()` matches the known busy texts (`(T-SBX-4)`, "concurrent attempts
  cannot be isolated", "they run one at a time", `capacity reached (n/m)`, "worker is shutting down", "another attempt of
  this job is running here", `machine_admin_busy:`) → transient with the 15 s default; anything else stays permanent
  (pre-p9 behaviour).
- **Master** (`apps/master/src/queue/declines.ts`): the inbox records every decline in `job_declines` (kind, classified
  by worker / legacy text, the worker's other unreleased leases at that moment, `retry_at`). Placement facts:
  `declinedBy` = permanent declines only (still `declined_before`, permanent); the latest transient decline per worker
  whose `retry_at` has not passed becomes `busyDeclines`. Placement excludes such a worker with the **transient** reason
  `declined_busy` ("waiting: desktop-pc busy for host-restricted …") only while its active lease count is still ≥ the
  count at decline time; it is asked again as soon as one of its jobs ends, or after `retry_at`. The job stays QUEUED;
  `placementAllowsFallback` treats `declined_busy` like `no_free_slot` (wait for the machine, do not switch runtime).
  Declines recorded before the migration are classified from their text at read time.
- No hot loop: with the active-count rule a busy worker is not re-asked while nothing changed; the retry time bounds the
  rare case where the busy state is not a lease the master sees (shutting down).

## 3. Per-profile slots (§2)

- `CAPABILITIES.profileConcurrency?: {container?, runtime-sandbox?, host-restricted?, unconfined?: 0..64}` and
  `exclusiveProfiles?: SandboxProfile[]` with feature `profile-slots-v1`. **Generic** on purpose: any build reports what
  its isolation supports; p9-windows-host-isolation (per-job users + ACLs) reports `host-restricted: n` and drops it from
  `exclusiveProfiles`. A profile left out is bounded by `maxParallelJobs` only.
- Worker (`apps/worker/src/sandbox/profile-slots.ts`, same facts `selectProfile` enforces): container = max; host
  profiles = the host runner's `hostRestrictedConcurrency()` (ADR-0034: macOS Seatbelt = slots, Windows with verified
  per-job accounts = min(healthy accounts, slots), otherwise 1), exclusive only without filesystem confinement
  (`none`: Linux / Pi host runs, Windows without accounts); unconfined = 1 and exclusive. The per-job-account busy
  refusals ("all n per-job account(s) are busy", "an unconfined attempt is running") are transient as well. Note: the
  master counts host-restricted and runtime-sandbox separately while the Windows account pool is shared; an over-ask
  is answered by a transient decline (runtime-sandbox is not offered on Windows today).
- Master: stored in `workers.profile_concurrency` / `exclusive_profiles`, re-validated, used only from workers that
  advertise the feature. Placement counts the master's own unreleased leases per profile (`jobs.spec.sandboxProfile`)
  and adds the transient `no_free_profile_slot` ("waiting: <machine> busy for <profile> (1/1 host-restricted slot in
  use)") when the profile is full or exclusive while anything runs. A profile reported with 0 slots is permanent
  (`sandbox_profile_unavailable`).
- UI: the fleet overview's `queue` object; machine list / page "3 slots (host: 1)" (`slotsLabel`).

## 4. Priority classes (§3, owner decision S2 — efficiency first)

- Console: Acil · Normal · Arka plan. Stored as the numeric priority (Acil +50, Normal 0, Arka plan −50); bands urgent
  50…100, normal −49…49, background −100…−50 (`PRIORITY_CLASS_BAND`, `priorityClassOf`). The number stays editable under
  "Advanced" in the composer.
- Dispatch order (`fairOrder`): classes first (all urgent, then normal, then background), and inside a class the existing
  aging (+1 per 60 s within a project) and weighted fair share across projects. The class comes from the stored /
  adjusted priority, never from the aged one: aging orders jobs inside a class but never lifts a background job into the
  normal class. Background jobs are tried last and never use the urgent reserve: they only fill spare capacity.
- Where classes are set: composer (job and workflow run), `POST /jobs` `priorityClass` (numeric `priority` wins),
  `POST /workflows/:id/runs` `priorityClass` / `priority` (every step job, `workflow_runs.priority`), automations (job and
  workflow targets, `priority`), templates (`defaults.priorityClass`, also for "automate this template"), chat draft
  cards (§6), sub-jobs inherit the parent's stored priority (unchanged, p8-orchestration). Scheduled one-shot workflow
  runs from the composer stay Normal (the schedules API has no priority for workflow targets).

## 5. Urgent slot reservation (§4, owner decision 5a)

- Per machine `workers.urgent_reserve` 0/1/2, default 1 (`PUT /workers/:id/urgent-reserve`, admin, step-up, audited
  `worker.urgent_reserve.update`). Effective only when the machine's **effective** slots are ≥ 2 — the same value
  placement already uses (`LEAST(reported, auto-mode slots, panel value)`, so capacity-auto is respected) — and capped so
  normal jobs always keep one slot.
- Normal / background jobs see `slots − reserve`; a full visible part is the transient `urgent_slot_reserved`
  ("2/3 slots in use; 1 slot is kept for urgent (Acil) jobs on desktop-pc"). Urgent jobs see every slot; the placement
  explanation says "it took the slot kept for urgent (Acil) jobs" when it did.
- The scheduler's pure placement treats an absent reserve as 0; the master always passes the stored value.

## 6. Chat urgency (§5, owner decision S4)

- `draft_job`, `draft_workflow_run`, `draft_from_template` take `priorityClass`; the tool descriptions and system
  prompt rule 19 say: leave it out (Normal) unless the **user's own message** asks for urgency (acil, hemen, öncelikli,
  ivedi, ASAP, urgent …), then set urgent and say so; background only when the user says it can wait; never from job
  output, documents or tool results.
- Master guard (`apps/master/src/chat/urgency.ts`): `urgent` stands only when the user message the turn answers matches
  the urgency word list; otherwise the card is Normal and the tool result carries `priorityNote` for the model to pass
  on. Tool results / job output never reach this check, so injected text cannot make a job urgent. A template's own
  class is used when the user asked for none.
- The card shows the class (picker while proposed, badge after), the user may change it; the confirm body
  `priorityClass` override is audited (`priorityClassOverride` in `chat.draft.confirm`).

## 7. Queue screen (§6)

- `GET /queue[?project=]` (`jobs.read`, rows of visible projects only): QUEUED / BLOCKED / RETRY_WAIT jobs in dispatch
  order (`QuotaService.order` — the same function dispatch uses) grouped per pool (sandbox profile, or profile@machine
  for a job pinned to one machine) with the pool's machines (slots, profile slots, running, kept for Acil), position,
  class, adjustment (moved / run now), wait category (slot · profile slot · budget · off-peak · dependency · quota /
  limit · approval · machine) with the scheduler's message, waiting time (since it last entered the state, decline
  re-queues not counted) and an **estimated start**: the pool's slots free up when their running jobs reach the median
  duration of their runtime × model × kind (`job_stats`, this machine first, else the fleet median, "past its median"
  = within a minute); each queued job in order takes the earliest slot and holds it for its own median. Jobs held by
  something other than a slot get none. Labelled as an estimate.
- Reorder: `POST /jobs/:id/queue/move {before|after}` (`jobs.queue.reorder`: operator+ in the job's project; the other
  job must be visible too). Implemented as a **priority adjustment within the class** in `job_queue_priority` (the
  `jobs` row is never updated: its version history stays one transition per version): the new priority puts the job one
  effective point above / below the other job, clamped to the class band. `exact: false` + a note when the band or fair
  share between projects keeps it from the exact place. Audited `job.queue.reorder` (from, to, relative job).
- Run now: `POST /jobs/:id/queue/run-now` (`jobs.queue.runnow`: admin, step-up) → urgent, one above the highest queued
  priority (≤ 100), dispatched at once. Audited `job.queue.run_now`.
- UI: Jobs → Queue tab (`?tab=queue`), drag and drop plus ↑ / ↓ buttons (keyboard / touch), "Run now" with step-up;
  viewers read-only. Polls every 5 s while visible.

## 8. Limits (§7) and long-wait notification (§8)

- Project queue settings (`GET/PUT /projects/:id/queue-settings`, `projects.execution.read` / `.write` + step-up,
  audited `project.queue.update`): `maxPerUser`, `maxPerAutomation` (null = off, the default; 1–100) and
  `waitNotifyMinutes` (default 15, 0 = off). The limits are a dispatch admission (`QueueService.admit`, after the off-peak
  deferral, before quotas): a person's own jobs (automation jobs count against the automation, not the run-as user) /
  an automation's jobs (direct or via its workflow run) in the project → transient holds `user_concurrency` /
  `automation_concurrency`. The job waits; it never fails.
- `job.waiting` notification (new kind; CHECK constraints redefined with every kind on main): a tick step finds QUEUED
  jobs waiting longer than their project's threshold (since they last entered QUEUED; off-peak deferral and dependency
  waits excluded), records `job_wait_notices` (once per job), notifies the creator (in-app + their enabled channels) and,
  for a job confirmed from a chat card, adds a note to that thread (p6-chat-notify path). Audited `job.waiting.notify`.

## 9. Security review

| Concern | Mitigation |
| --- | --- |
| A worker claims "transient" to keep a job forever | The job only waits; it never runs elsewhere less safely. Other eligible workers still get it; a permanently declining worker is still excluded. Retry is bounded (≤ 1 h) and needs a lease count drop or the retry time. A malicious worker could already refuse every job before p9. |
| A worker reports more profile slots than it can isolate | The worker's own `selectProfile` still enforces T-SBX-4 and declines; the master's count only avoids asking. Values are re-validated (known profiles, 0–64) and used only with `profile-slots-v1`. |
| Priority escalation via chat / prompt injection | Urgent needs the user's own words in the turn's user message (master guard, not only the prompt); job output and tool results never reach it; the card shows and lets the user change the class; overrides audited. |
| Queue reorder across projects / probing | Move needs `jobs.queue.reorder` on the moved job's project and `jobs.read` on the other job's project (else 404); a move never changes the class; run now is admin + step-up; every change audited. Viewers get the same rows read-only (`canReorder: false`). |
| Information disclosure in the queue | Rows are filtered by visible projects; machine names / slot counts are already visible to every role (`workers.read`); titles are the first prompt line rendered as text. |
| Notification abuse | One notice per job (primary key), only to the job's creator, body built from ids and scheduler reasons, passed through the notification redactor. |
| Lease / job integrity | The `jobs` row and its transition history are untouched (adjustments live in `job_queue_priority`); decline recording happens in the same transaction as `lease_declined`. |

## 10. Rollback

Forward-only migration; rolling the code back leaves the new columns / tables unused (pre-p9 behaviour: a decline is
permanent again, no reservation). Setting every `workers.urgent_reserve` to 0 turns the reservation off without a
deploy.

## 11. Tests

- Scheduler: `packages/scheduler/test/queue-priority.test.ts` (busy declines, production case waiting vs infeasible,
  per-profile slots, exclusivity, reservation incl. capacity bounds, class tiers with aging / fair share, owner holds).
- Protocol: `packages/protocol/test/queue.test.ts` (LEASE_ACK / CAPABILITIES fields, legacy classification incl. the
  exact production text, class bands).
- Worker: `apps/worker/test/profile-slots.test.ts`, decline kinds in `job-runner.test.ts`.
- Master integration with real worker daemons: `apps/master/test/integration/queue-priority.test.ts` — the production
  case (Windows-like T-SBX-4 runner; second host job waits and runs after the first, never FAILED), an old worker without
  `declineKind` (text classification), a `profile-slots-v1` worker (never asked), urgent reserve + admin change, queue
  order / drag / run now / viewer, per-user limit, long-wait notice once. RBAC matrix and route coverage include the new
  routes and actions.
- Web: `apps/web/test/queue-priority.test.tsx` (queue tab, ↑ and drag and drop, run now with step-up, viewer, composer
  classes, chat card class + override) and the fork-built tests for automations / templates / project / machine
  settings.

## 12. Addendum: subscription-login accounting (p9-queue-local-login-accounting, 2026-10-17)

### 12.1 Live finding

Prod, one Windows worker (win-1, worker 1.0.32, 3 slots, urgent reserve 1, per-job accounts verified;
since p9-windows-slots-local-login a `local-login` host attempt runs as the worker account, one at a time and alone).
The Queue tab said "1 running of 3 slots · 1 kept for Acil", a Codex job "Profile slot: waiting: … busy for
host-restricted (it declined while running 1 job …)" and a Claude Code job "Slot: 2/3 slots in use; 1 slot is kept for
urgent (Acil) jobs". The owner asked why two jobs wait with one running. The audit showed both queued jobs cycling every
~6–8 s: context bundle issued → reserve → transient decline → requeue.

Causes:

1. **A re-ask held a slot.** The master learned the local-login rule only from the worker's decline (`BUSY_SOON`,
   5 s). Every 5 s it re-asked the busy-declined job; that re-ask is a real lease (RESERVED) until the worker declines
   it a moment later. The job behind it was placed in the same dispatch pass and counted it: "2/3 slots in use". The
   queue shows the stored reason, so the snapshot stuck.
2. **The re-ask loop fed itself.** A decline records the worker's other active leases (`job_declines.active_leases`).
   A decline recorded while the other job's re-ask was pending counted it (2); when that re-ask was declined the count
   fell to 1 — "a job finished" — and the job was asked again at once.
3. **The master could not know** that a subscription-login job only starts on an idle machine, so it asked.

### 12.2 Changes

- **Slot accounting (A).** A slot-holding lease is an unreleased lease that is not the pending re-ask of a job this
  worker declined as busy before (`slotLease()` in `apps/master/src/queue/facts.ts`: RESERVED with a transient
  `job_declines` row for the same job and worker). Placement (`activeLeases`, per-profile counts), the decline's
  recorded count and the queue screen's "running" all use it. If such a re-ask is accepted the job leaves RESERVED and
  counts again; an over-ask in that short window is answered by the worker's own capacity check (a transient decline).
- **Busy back-off.** Consecutive busy declines of a job by the same worker wait the worker's `retryAfterMs`, doubled
  per further decline, capped at 5 min (`busyBackoffMs`, never shorter than the worker asked). A job of that worker
  ending still re-asks at once (the active-count rule), so a real free slot is never missed.
- **The worker reports the rule (B).** `CAPABILITIES.localLogin` (additive, with `profile-slots-v1`):
  `{ runtimes, exclusiveProfiles }` — enabled runtimes whose effective `runtimeAuth` is `local-login`, and the ready
  host profiles in which such an attempt runs alone (only with per-job Windows accounts, `job_user`; without
  confinement every host attempt is already exclusive, with Seatbelt they run in parallel). Stored in
  `workers.local_login` (migration 0072), used only with the feature. Mirrors `selectProfile`, which stays the
  enforcement point.
- **Placement knows it up front.** The job's auth mode is decided the way the worker's env plan does: a model profile
  with a `credentialRef` (job or chosen fallback runtime) → API key on every worker; otherwise the worker's
  `localLogin.runtimes`. In an exclusive profile a subscription-login job waits while the machine runs anything, and any
  other job of those profiles waits while a subscription-login job runs — the transient reason
  `subscription_login_exclusive` ("Claude Code / Codex subscription logins run one at a time on <machine> (shared
  login); API-key jobs can run in parallel (n running)" / "a … subscription-login job is running on <machine>; it runs
  alone …"). No LEASE, no attempt, no context bundle, no audit churn. The fallback rule treats it as busy (the job
  waits for the machine instead of switching runtime). The active subscription-login count is the master's own (job
  spec + `job_runs.runtime_choice` of each slot-holding lease).
- **Urgent reserve (D).** The reserve applies only where at least two *parallel* slots of the job's profile can be
  used (`parallelSlots`: the machine's slots bounded by the profile's concurrency; 0 for an exclusive profile; 0 for a
  subscription-login profile when every installed, logged-in (and, managed, enabled) runtime uses the subscription
  login), capped at parallel − 1; and never to a subscription-login job itself (it needs an idle machine anyway).
  Keeping a slot for Acil where only one-at-a-time work runs would only hold normal jobs back. A job with its own
  model-profile credential on such a machine still runs in parallel, just without a reserve.
- **Queue screen (C).** Wait category `subscription_login` ("Subscription login", first among the machine-side
  categories); the row shows the reason behind its category (reasons are sorted by code); the pool header gets
  `urgentReserveEffective` and `subscriptionLogins`: "win-1: 1 running of 3 slots · 1 kept for Acil ·
  subscription logins: 1 at a time" ("kept for Acil" only when it applies).

### 12.3 Compatibility, security, rollback

- Workers without `localLogin` (≤ 1.0.32): the decline path stays, now without the phantom slot and with back-off.
  The worker release adds the report; nothing else changes on the worker.
- Security: the report only narrows what the master asks; a worker claiming exclusivity only delays its own jobs. A
  worker hiding it is still refused by its own `selectProfile`. Values are schema-validated (known runtimes and
  profiles) and used only with `profile-slots-v1`. No secret or credential crosses; the auth mode is derived from
  stored job specs and the worker's report.
- Rollback: the code rollback leaves `workers.local_login` unused; the index on `job_declines` is harmless.

### 12.4 Tests

- Scheduler: `packages/scheduler/test/queue-local-login.test.ts` (production case, idle machine, API-key beside /
  after a subscription job, own credential, other profiles and old workers, reserve rules).
- Master unit: `apps/master/test/unit/queue-local-login.test.ts` (report parsing, slot counts, back-off, category).
- Master integration with real worker daemons: `apps/master/test/integration/queue-local-login.test.ts` — worker
  1.0.32 behaviour (no report): back-off windows (no re-reservation inside them, doubling), a pending re-ask that
  never takes a slot (the job behind it is asked instead of "2/3 … kept for Acil"; fails without the fix); with the
  report: the production case (both queued subscription jobs wait on the login, never asked, no attempts; queue
  category and header; reserve 0), API-key jobs parallel but never beside a subscription job.
- Worker: `apps/worker/test/profile-slots.test.ts` (localLogin only with per-job accounts and local-login runtimes).
- Protocol: `packages/protocol/test/queue.test.ts`. Web: `apps/web/test/queue-priority.test.tsx`.

## 13. Addendum: per login store and per job family (p9-subjob-local-login-deadlock, 2026-10-17)

With `CAPABILITIES.localLogin.stores` the up-front hold of §12 is narrower: a subscription-login job waits for a running
login job on the same store (`subscription_login_busy`) and for jobs of another family (`subscription_login_exclusive`);
other jobs wait only for another family's login job. Slot-holding leases carry their job and family for it, and a
waiting parent learns `blocked_by_parent` when its sub-job can only start after the parent. Design:
[p9-subjob-local-login.md](p9-subjob-local-login.md).

## 14. Addendum: the reserve on small machines and the family exception (p11-fixes-a, 2026-10-19)

Found live: with the default reserve of 1, a 2-slot machine ran ONE normal job, and a coordinator waiting for its own
sub-job on that machine blocked the sub-job (`urgent_slot_reserved`). Two changes (scheduler `placement.ts`):

- **Default only from 3 slots.** `workers.urgent_reserve` is nullable (migration 0090): NULL = the default — 1 slot only
  where at least `DEFAULT_RESERVE_MIN_SLOTS` (3) parallel slots can be used, else 0 (`configuredUrgentReserve`). A number
  is an admin's explicit setting and applies from 2 slots on as before. The migration turns rows still at the old
  column default 1 that no admin ever set (no successful `worker.urgent_reserve.update` audit event) into the default.
  `PUT /workers/:id/urgent-reserve` accepts `reserve: null` (back to the default); views carry `urgentReserveAuto`.
- **Family exception.** A family member (sub-job, or an integration / resolution / fix / verify job of a coordinator's
  integration — `jobFamily` / `familySql` now also follow `integration_jobs` → `integrations.root_job_id`) is not held
  back by the reserve on a machine where its family already holds a slot (`familyHoldsSlot`): the parent there waits
  for it. Bounded: it never goes past `no_free_slot`, and another family's job still sees the reserve.
- Security: unchanged trust — family facts are the master's own rows; the setting stays admin + step-up + audited.
- Tests: scheduler `queue-priority.test.ts` (default vs explicit, family exception); master integration
  `queue-priority.test.ts` (real worker: 2 normal jobs on a 2-slot machine by default, explicit 1 holds the third, a
  sub-job of the running coordinator takes the reserved slot, back to default); `merge-pipeline.test.ts` now runs the
  coordinator + sub-jobs + integration on a 2-slot machine; web `queue-settings.test.tsx`.
