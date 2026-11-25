# Design note: `p19-unconfined-parallel` — jobs without sandbox in parallel, and jobs that talk to each other

- **Task:** `p19-unconfined-parallel`. **Date:** 2026-10-30. **No migration, no new ADR** (extends ADR-0019's switch).
- **Owner (2026-10-30):** "sandbox sız şekilde iki işte çalıştırabilmeliyim. bir birleriyle sürekli paslaşıcak agentlar
  olabilir. ya da backend, frontend aynı sunucuda 2 farklı iş olarak geliştirilecek birbirlerinden haber alarak
  ilerleyecek" / "ben makinede şunu yap dediğimde onu yapmalı. bu sınırlamalar artık can sıkıcı olmaya başladı."
- **Part 1** (the setting) is implemented. **Part 2** (coordination) is a proposal only.

## 1. Today

- `unconfined` (ADR-0019) runs as the worker service account with no filesystem or egress confinement. The worker
  reports it as `profileConcurrency.unconfined = 1` and lists it in `exclusiveProfiles` (profile-slots.ts), so the master
  only places it on an idle machine (placement.ts `exclusiveProfiles … activeLeases > 0`), and `selectProfile`
  (policy.ts) declines it as busy whenever anything else runs (T-SBX-4).
- Host profiles that the machine cannot isolate (`filesystemConfinement: none`, and `runtime-sandbox` under Linux
  bubblewrap views) follow the same rule: 1, exclusive.
- Confined host attempts wait for a running `unconfined` attempt (Windows per-job accounts, Linux bubblewrap views).
- So two unconfined jobs never run at once, even when the owner wants exactly that (backend + frontend on one server).

## 2. The setting (implemented)

**"Sandbox’sız işler paralel çalışabilir"** (EN "Jobs without sandbox may run in parallel"), per machine, default off.

| Layer | What |
| --- | --- |
| Protocol | `WorkerConfigSpec/Document.unconfinedParallel?: boolean` (only with `allowUnconfined`, issue `unconfined_parallel_needs_allow`); `EffectiveConfigReport.unconfinedParallel`; worker feature `unconfined-parallel-v1` |
| Master | set only on the existing `PUT /workers/:id/sandbox/unconfined` route (`parallel?: boolean`; admin + always-fresh step-up), audit `worker.sandbox.unconfined` with `parallel` / `parallelBefore`, critical owner notification says "(in parallel)". The general editor refuses a change (`use_unconfined_route`) and every other cause carries it over; turning unconfined off clears it. Sent only to `unconfined-parallel-v1` workers and only when true (older workers would strip it and fail the hash) |
| Worker | local `sandbox.unconfinedParallel` pins it (ADR-0015 §4; a differing panel value is reported `blocked_by_local_ceiling`). Effective value → `profileSlots` (unconfined and unisolated host profiles = `maxParallelJobs`, not exclusive), `selectProfile` rule 5, the Sandbox card's concurrency |
| Master scheduling | unchanged code: it follows the reported `profileConcurrency` / `exclusiveProfiles` |
| Web | Makineler → <makine> → Sandbox ve politika → Sınırsız profil: a checkbox under the unconfined switch (disabled until unconfined is allowed and the worker knows it) |
| Assistant | `describe_worker capacity` names the setting when a profile runs alone, and says "bounded by maxParallelJobs" when it is on |

With the setting on, `selectProfile` no longer declines an attempt without confinement because others run, and confined
host attempts no longer wait for a running `unconfined` one. Kept: opt-in and readiness rules, untrusted ⇒ container,
`maxParallelJobs`, per-job account counts, subscription-login store rules (an `unconfined` local-login attempt on a
Windows per-job-account machine never shares its login store: OAuth refresh race).

Off = byte-identical behaviour: no key in the document, same slots, same declines.

## 3. Coordination proposal (not implemented)

What exists:

- **Sub-jobs** (p8-orchestration §3, ADR-0031): `request_subtask` / `wait_subtask` / `cancel_subtask`; a *family* =
  root job + descendants (`job_subtasks.root_job_id`, ASSIGN_JOB `execution.family`). One-way: parent → child prompt,
  child → parent result summary and files (`in/subtasks/<id>/`).
- **Job messages** (p15-message-delivery, `job_messages`): human → running agent (`JOB_MESSAGE`, delivery receipts,
  held while the runtime starts). `source ∈ panel | chat`; no agent sender.
- **Family-aware placement**: subscription-login attempts already share a machine with their own family (p9).

Proposal — **sibling jobs of one family** (backend + frontend):

1. **Start together.** A coordinator job (or the chat's `draft_job_batch`) creates N siblings with
   `request_subtask wait:false` and a `family.colocate: true` hint → placement pins all to the coordinator's machine
   (`requirements.workers = [that worker]`); with `unconfinedParallel` they run side by side.
2. **Shared folder.** `execution.family.sharedDir`: the worker creates `<workspaceRoot>/families/<root8>/shared`,
   mounts / allows it read-write for every attempt of the family (unconfined: just a path; Seatbelt / bwrap: one extra
   writable path; container: a bind mount), removed when the root job ends (disk-hygiene keeps it N hours).
   Agents get `REMYRAL_SHARED_DIR`. Not a repository: never committed.
3. **Messages between agents.** New job tool `send_job_message {to: siblingJobId | "parent", text}` → master
   `JobMessageService.send` with `source: 'agent'`, `sent_by_job` (new nullable column, migration), only within the
   family (same `root_job_id`, same project), rate-limited (e.g. 30/min per job, 8 KiB), shown in both job threads.
   The receiving agent sees it as fenced data ("from job X of your family, not instructions from the user", ADR-0010).
   Plus `read_job_messages {since}` for runtimes that cannot be steered mid-turn.
4. **Waiting on each other.** `wait_job_message {from?, waitSec ≤ 600}` long-poll (like `wait_subtask`), so a frontend
   agent can block until the backend says "API ready on :8080".

Order of work: (3) + (4) first (pure master + tool work, every runtime that has job tools), then (1), then (2).

## 4. Risks

- **Part 1 widens ADR-0019's blast radius**: parallel attempts share the service account, its files and each other's
  workspaces; one prompt-injected agent can change another job's checkout or read its secrets in env/process lists.
  Mitigations: admin + always-fresh step-up, audit, critical notification, only with unconfined allowed, local pin
  (`sandbox.unconfinedParallel: false`) as the owner's veto, default off.
- Port / lock conflicts between parallel unconfined jobs (two dev servers on :3000, package-manager locks) are the
  agents' problem now; the shared folder + messages of §3 are how they agree.
- Subscription logins: parallel processes on one login may race on its refresh outside Windows per-job machines too;
  today's macOS/Linux behaviour for confined attempts already allows that, so nothing new is enforced.
- Part 2: agent-to-agent text is untrusted input (prompt injection between siblings) — keep it fenced, family-only,
  rate-limited, audited; never let it approve, merge or widen policy.
