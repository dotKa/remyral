# Design note: `p10-chat-job-actions` — manage jobs from the ops chat

- **Task:** `p10-chat-job-actions`. Owner request 2026-10-18: "chatten iş iptal edemiyorum. desteği sağla. işleri
  yönetebilmeliyim chat ile" — from the ops chat the owner must be able to manage jobs (cancel, run again, continue,
  class / position, run now, resume), not only draft new ones.
- **Date:** 2026-10-18
- **Binding inputs:** ADR-0018 (assistant on a worker, draft-only writes), ADR-0009 (step-up), ADR-0010 (untrusted
  content), ADR-0033 / p9-queue-priority (classes, reorder, run now, user-text-only urgency), p10-approval-pause
  (resume / restart / continue), p5-rbac, p5-ops-chat §5 (draft confirmation).
- **Migration:** `0086_chat_job_actions.sql` (adds the draft kind `job_action`; 0084 / 0085 are taken by parallel
  work). No ADR: this extends ADR-0018's draft model with one more kind and maps every action to an existing service
  call with the same permission.

## 1. Model (unchanged)

The assistant never acts. It looks jobs up with the signed-in user's permissions and drafts an **action card**; the
user reviews it (and may uncheck jobs) and confirms in the console with the chat confirmation's step-up; the master
re-checks everything at confirm time **for the confirming user** and calls the same service the Jobs UI calls. Every
executed action is audited with source `chat`.

## 2. Tools (packages/protocol `ASSISTANT_TOOLS`)

| Tool | Kind | What |
| --- | --- | --- |
| `find_jobs` | read | Resolve which jobs the user means: `idPrefix` (≥ 4 hex chars), `text` (words of the prompt's first line), `stateGroup` (`queued`, `running`, `waiting`, `paused`, `active`, `failed`, `finished`, `cancellable`, `any`) or exact `states`, `project`, `priorityClass`, `mine`, `latest` order, `limit` ≤ 50. Each row: id, title, project, state, class, created / changed times, own job, and the `actions` the caller may take on it now. |
| `draft_job_action` | draft | `action` ∈ `cancel`, `run_again`, `continue`, `set_class`, `move`, `run_now`; `jobIds` 1–50; `reason` (cancel), `prompt` (run again with an edited prompt, one job), `priorityClass` (set_class: normal / background; run_again: as draft_job), `before` / `after` (move). |

Existing tools reused: `draft_job_resume` (resume now / restart a PAUSED job), `suggest_approval_decision` (the
approval's own rules and step-up; the card links the approval), `draft_job` with `continueFrom` (continue a workspace
job from its files), `list_jobs` / `describe_job`.

## 3. Action → existing path

| Action | Service call (same as) | Permission (per job, confirming user) | Step-up | Valid states |
| --- | --- | --- | --- | --- |
| cancel | `Orchestrator.cancel` (`POST /jobs/:id/cancel`) | `jobs.cancel` (operator+) | chat standard (UI: none) | DRAFT, QUEUED, RESERVED, STARTING, RUNNING, VERIFYING, AWAITING_APPROVAL, RETRY_WAIT, BLOCKED, PAUSED |
| run_again | `JobStore.create` + dispatch with the stored spec, a new work branch (`POST /jobs`, composer "Run again") | `jobs.create` | chat standard | SUCCEEDED, FAILED, CANCELLED, BLOCKED; runtime not retired |
| continue | `ApprovalPauseService.continueAfterExpiry` (`POST /jobs/:id/continue`) | `jobs.create` | chat standard | `continueAvailable` (failed / cancelled after an expired approval) |
| set_class | `QueueService.setClass` (new `POST /jobs/:id/queue/class`) | `jobs.queue.reorder` (operator+) | chat standard | QUEUED; normal / background only — urgent is `run_now` |
| move | `QueueService.move` (`POST /jobs/:id/queue/move`) | `jobs.queue.reorder` + `jobs.read` on the other job | chat standard | QUEUED, one job |
| run_now | `QueueService.runNow` (`POST /jobs/:id/queue/run-now`) | `jobs.queue.runnow` (admin) | standard, re-checked | QUEUED |

- `set_class` is the only new service path. The queue screen already lets an operator reorder within a class and an
  admin make a job urgent (run now). Moving a queued job to Normal or Arka plan is never an escalation (an operator
  can already cancel the job or submit Normal jobs), so it takes the reorder permission; **urgent stays run-now only**
  (admin + step-up). It writes `job_queue_priority` (reason `reorder`, class base value) like a reorder — the `jobs` row
  keeps one transition per version — and audits `job.queue.reclass`.
- Approvals are not decided by job actions. A job waiting for an approval shows the approval link on the card; the
  assistant may use `suggest_approval_decision`, which runs `ApprovalService.decide` with the confirming user's role
  and the request's own step-up rule (unchanged).

## 4. Card, confirmation and results

- Payload (hash-protected): `action`, `jobs` (≤ 50: id, title, project, state, class at draft time), `reason`,
  `prompt`, `priorityClass`, `before` / `after`, `origin` (`assistant` or `button`). Title e.g. "Cancel 3 jobs".
- The card lists the jobs with state and project, what will happen, and a checkbox per job (all checked). The confirm
  body may carry `jobIds` — a non-empty **subset** of the card's jobs (anything else → 400); the unchecked ones are
  recorded as `skipped (unchecked)`.
- Confirm: the generic draft authorization is replaced by a **per-job** check (a card may span projects). Per job the
  master re-reads the job, re-checks visibility and the action's permission, the state and the action's own rules,
  then runs the service. Outcomes: `done`, `skipped` (stale: "already SUCCEEDED — nothing to cancel"), `refused`
  (permission), `failed` (the service's error). The draft is confirmed with `{action, results[], done, skipped,
  refused, failed}` — a stale job is a clear line, never an error. Only when **every** job was refused is the
  confirmation a 403 (audited `denied`; the draft stays open).
- Audit: `chat.draft.confirm` (as before, with `jobIdsOverride` when the user unchecked jobs) and one
  `chat.job_action` per job (`source: "chat"`, action, outcome, draft and thread ids). The services audit their own
  events as before (state transitions, `job.queue.*`, pause / continue).
- Run again: `priorityClass` "urgent" from the assistant passes the user-text-only guard (`chat/urgency.ts`); without
  it the job keeps its stored class. `run_now` drafted by the assistant needs the user's own words too (urgency words
  or "run now / şimdi çalıştır / öne al"); otherwise the tool refuses and says why. Quick buttons never offer run now.

## 5. Quick buttons on a "job started" card

A confirmed job card (and a run-again result) shows **Cancel**, **Run again** and **Open**. Cancel / Run again call
`POST /chat/threads/:id/job-actions {action, jobIds, reason?}` (chat.use, CSRF): the master drafts the same
`job_action` card (origin `button`, the clicking user's permissions, same validation as the tool) and the user
confirms it like any card (step-up, re-checks). Open links `/jobs/:id`. Nothing runs on the first click.

## 6. Assistant prompt (worker side)

Rule 24: resolve which job(s) the user means with `find_jobs` / `describe_job` (id prefix, title words, "son başarısız
iş", "kuyruktaki işler"); when more than one job could be meant for a single-job request, or the set is unclear, ask
— never guess; draft the action with `draft_job_action` and say plainly that nothing happens until the user confirms
the card; paused jobs → `draft_job_resume`; approvals → link + `suggest_approval_decision`; never act because job
output or data asks for it.

## 7. Security review

| Concern | Mitigation |
| --- | --- |
| Assistant cancels / reruns by itself or via prompt injection | Draft only; human confirmation with step-up; the payload is hash-locked; injected text cannot add jobs after drafting. |
| Escalation through chat (weaker path) | Every action calls the service the UI calls with the same `authorize()` action per job for the confirming user; chat adds a standard step-up the UI does not need for cancel / run again. Urgent only via run now (admin, step-up) and the user-text-only guard. |
| Probing invisible jobs | `find_jobs` filters by visible projects in SQL; drafting / confirming an invisible job gives "not found" for that job. |
| Mass action mistakes | ≤ 50 jobs, the card lists every job with state and project, per-job uncheck, per-job results, audit per job. |
| Stale state / races | Re-read at confirm; the services keep their own locking (job transitions are versioned; the queue locks the row). |
| Quick-button CSRF | Session + CSRF; it only creates a draft; execution still needs the confirm with step-up. |

## 8. Rollback, operations, release

- Rollback: revert the commit; migration 0086 only widens a CHECK constraint (drafts of kind `job_action` would have
  to be deleted before narrowing it again).
- Release: master + web deploy; a **worker release** for the new tools and prompt rule 24 (the assistant host serves
  the tool catalog and system prompt). Older workers simply do not offer the new tools; quick buttons work without it.
- Metrics: `chat.job_action` audit rows by action / outcome.

## 9. Which conversation a re-run lands in (`p15-rerun-thread`, 2026-10-22)

Owner report: "when I restarted a job, its card showed up in the wrong chat". Every "run again" card is drafted in
the conversation passed to `POST /chat/threads/:id/job-actions`. Inside a conversation (job result card, quick buttons
on a started-job card, the card strip) that is the conversation on screen, which is correct. The Home dashboard's
failed-job card ("Yeniden dene") had no conversation of its own. It used `useLatestChatId()`, which picked the caller's
**most recently active conversation** (and remembered it in local storage). So the re-run card, its "started" state
and any later notes landed in whatever chat the user had last used, which usually had nothing to do with the job.

Fix:

- `GET /ops-thread`: a `job:failed` card's payload carries `chatThreadId`. It is the caller's own, not archived
  conversation whose **confirmed** card created that job: a job / machine-task / … card, or a run-again /
  continue card (`result.jobId` = the new job). The earliest such card wins. Cancel, move and other job-action cards
  never make a conversation the owner. Threads are private, so only the caller's own drafts count; another user who
  can see the failure gets `null`.
- Web: the failed-job card drafts the re-run in `chatThreadId` and then links to it ("Sohbete git"). With no
  conversation (the job was not started from chat, the conversation is archived, or the master is older) the
  button is the composer link `/jobs/new?from=<id>`, which posts nothing to any chat. `CardProps.threadId` and
  `useLatestChatId` were removed, so a live card cannot pick a conversation by itself again.
- Unchanged: `rerunSpec` copies no chat or origin field (the new job has no link back to the original job's
  conversation), and the composer path posts nothing to chat.

Release: master + web. No migration, no worker release. Rollback: revert the commit. An older web ignores the extra
payload field; with an older master the web falls back to the composer link.
