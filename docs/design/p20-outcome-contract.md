# p20-outcome — "a result or an explicit intervention" contract

Owner 2026-10-30/31 (complaints #1–4): "işler bu şekilde boşta kalmamalı. devam etmeli ya da benim müdahalem
gerekiyorsa müdahale etmeliyim. sistem işimi kolaylaştırmalı. sürekli kontrol etme ihtiyacı duymamalıyım."
Research: `ux-research-2026-10-31/sentez.md` ("Asıl iş", P0) and the four Tur 3 reports.

## Problem

A request from a conversation splits into a draft, a job, a plan, a watch, a workflow run, approvals and questions.
Each part has its own continuation rule — plan `cont_due` (`chat/plans.ts`), watch `follow_up`
(`chat/watch-follow-up.ts`), `job_wait_notices` (`queue/service.ts`) — its own clock and its own notification path.
When the automatic recovery runs out (the watch follow-up cap of 3 in 6 hours, a stalled plan, retries / auto-fix
exhausted, the assistant unreachable) nobody owns the next step and the person meets silence. Two delivery gaps make it
worse: the plan continuation drops `cont_due` before the turn exists, the watch follow-up writes `follow_up = 'sent'`
before the turn exists — a process that dies between the claim and the send loses the continuation for good.

## Contract

Every open goal born in a conversation ends in **a result** or in **one explicit, persistent intervention** that says
what was asked, what happened (a concrete reason), what the next step is and what the person can do. Never silence.

No new scheduler: the goal row is a ledger over the existing records. Their own engines (queue, plan continuation, watch
engine, workflow engine, watch follow-up) keep doing the work; the ledger only records who owns the next step and turns
"nobody owns it" into an intervention.

## Data model (migration 0204)

`chat_goals` — one row per open goal of a conversation:

| column | meaning |
|---|---|
| `id`, `user_id`, `thread_id` | the source: who asked, where |
| `origin_kind`, `origin_id` | the record that opened it: `plan` / `job` / `workflow_run` / `watch` (unique) |
| `title` | what was asked (the plan title, the job / run / watch label) |
| `outcome_condition` | short text: what counts as done (set by the ledger, refined by the assistant with `goal_update`) |
| `next_action` | coded next step (`job_running`, `watch_waiting`, `follow_up`, `assistant_turn`, `plan_continue`, `user_decision`, `user_action`, …) plus optional assistant text (`next_note`) |
| `owner` | `assistant` / `user` / `job` / `workflow` / `system` — who moves it next |
| `blocked_reason` | coded: `follow_up_cap`, `follow_up_window`, `assistant_unavailable`, `assistant_error`, `budget`, `job_failed`, `run_failed`, `plan_stalled:<why>`, `plan_item_failed`, `no_progress`, `assistant_declared` |
| `reevaluate_at` | when the ledger looks again; past it without progress → intervention |
| `state` | `open` / `done` / `intervention` / `cancelled` |
| `detail` | the concrete "what happened" (a watch's end reason, a job's error summary, the assistant's words) |
| `user_action` | what the person has to do (assistant text via `goal_update`, else derived) |
| `episode` / `notified_episode` | intervention episodes; one notification per episode |
| `opened_at`, `updated_at`, `closed_at`, `intervention_at`, `last_progress_at` | timestamps |
| `interventions`, `follow_ups`, `resolved_by` | measurement (see below) |

`chat_goal_links (kind, ref_id) → goal_id` — the records a goal owns (`plan`, `job`, `workflow_run`, `watch`, `draft`).
A record belongs to at most one goal (primary key `(kind, ref_id)`).

`chat_goal_ledger` — one row: `since`, the moment the ledger started (set on its first pass). Records older than that
are never adopted, so a deploy does not turn last week's failures into intervention cards.

## Delivery outbox (migration 0205)

`chat_deliveries` — the leased, idempotent hand-off of a system-written continuation turn:

| column | meaning |
|---|---|
| `key` (PK) | `plan:<planId>:<uuid>`, `watch:<watchId>`, `goal:<goalId>:<episode>` — the idempotency key |
| `kind`, `ref_id`, `thread_id` | what it continues |
| `state` | `claimed` / `sent` / `released` / `failed` / `expired` |
| `token` | fencing token of the current claim (a new one per claim) |
| `lease_until` | the claim's lease (2 minutes) |
| `message_id`, `turn_id` | the system message and the turn it became |
| `attempts`, `reason`, `created_at`, `updated_at`, `sent_at` | bookkeeping / measurement |

A partial unique index allows one live claim per `(kind, ref_id)` (also across replicas).

Flow (`chat/deliveries.ts`, `ChatService.send(..., { delivery: { key, token } })`):

1. **claim** — insert / re-claim the row with a fresh `token` and `lease_until = now + 2 min`.
2. **message transaction** — `send` locks the row, refuses (`409 delivery_superseded`) unless it is `claimed` with this
   token; the system message carries `meta.delivery = key`; the row records `message_id`.
3. **turn transaction** — the `chat_turns` row and `state = 'sent'` (+ `turn_id`, the kind's own mark: the watch's
   `follow_up = 'sent'`, the plan's `cont_turn`) commit together, fenced by the token again. "Sent" therefore exists
   exactly when the turn exists.
4. **errors** — a delay (`turn_in_progress`, `rate_limited`, `assistant_unavailable`) releases the row; a terminal
   refusal (budget, cost brake, other) marks it `failed` with the reason.
5. **reaper** (every pass of the owning service) — a claim whose lease ran out without `sent`: `expired`; a message it
   left without a turn is deleted; the plan gets `cont_due` back, the watch stays `follow_up IS NULL` (claimed again on
   the next pass, within the follow-up window). A slow sender whose lease ran out fails its fence in step 3: the turn
   is never created twice.

Compatibility: a sender that never reaches the chat service (a test double) is completed after a successful `send`
(`complete` is idempotent); the old columns keep their meaning (`follow_up = 'sent' | 'skipped:*'`, `cont_due`).

## Who updates the goal

Hooks plus reconciliation in the existing step loop (`chat-goals`, every 5 s — a step of the orchestrator loop like the
plan and watch steps, not a scheduler). Every input is a column the existing flows already write, so a restart or a
missed hook converges on the next pass.

| event (existing flow) | goal change |
|---|---|
| draft confirmed → job / run (chat drafts) | new goal (`job` / `workflow_run`), or linked to the plan / the goal of the turn that drafted it |
| plan approved / executing | new `plan` goal; its drafts' jobs / runs link to it |
| watch created (`notify_when`, `create_watch`) | linked to the goal of its target, of the turn that created it (follow-up / resume turn), of the active plan; else a new `watch` goal |
| job running / queued / waiting for approval | owner `job` / `user` |
| job succeeded | done (unless a linked watch is still active) |
| job failed for good | owner `system` for the auto-fix grace (10 min, `job_auto_fixes`); a fix job links and owns it; none → intervention `job_failed` |
| workflow run ended | succeeded → done; failed → intervention `run_failed`; cancelled → cancelled |
| watch fired | done |
| watch ended unmet | owner `assistant`, next `follow_up`, re-evaluated at the end of the follow-up window |
| follow-up turn sent | owner `assistant`, next `assistant_turn`, re-evaluated in 30 min; a new watch / job from that turn moves the goal on |
| follow-up skipped: cap / budget / error | intervention `follow_up_cap` / `budget` / `assistant_error` |
| follow-up never sent within the window | intervention `assistant_unavailable` (or `follow_up_window`) |
| plan stalled (`cost_brake`, `budget`, `turn_failed`, `no_progress`) | intervention `plan_stalled:<why>` |
| plan item at its failure cap | intervention `plan_item_failed` |
| plan executing, nothing under way, nothing waits for the person, no progress for 30 min | intervention `no_progress` |
| `reevaluate_at` passed while the assistant owns it | intervention `assistant_unavailable` when the chat is down, else `no_progress` |
| plan done / cancelled | done / cancelled |
| assistant `goal_update` | outcome / next step / done / cancelled / intervention with the assistant's words |
| person: "Devam ettir" / "Vazgeç" | open again (a plan: `resume`; else one `goal` continuation turn through the outbox) / cancelled |

An intervention that resolves by itself (the job succeeded after all, the person resumed the plan elsewhere) leaves
`intervention` on the next pass.

## The intervention card (/needs)

`GET /chat/goals?state=intervention` feeds a section of "Senden bekleyen": one card per goal — the row itself is the
card, so a goal never has two. It shows what was asked (title, conversation), what happened (`detail`, coded reason in
words), the next step and what the person should do, with one-click actions: **Devam ettir**
(`POST /chat/goals/:id/resume`), **Vazgeç** (`POST /chat/goals/:id/cancel`), **Sohbete git**. A plan goal whose plan
already has its card on the page (the plans section) is not drawn twice: the plan card carries it.

Notification: through the existing notification path (`chat.watch` kind, so the owner's channel preferences apply),
dedupe key `chat.goal:<id>:<episode>` — once per intervention episode. A plan stall already notifies through
`chat.plan` and is not notified again. A short note is posted in the conversation as well.

## Assistant (rule 66, worker 1.2.13)

Tools `list_goals` (read: this conversation's open / intervention goals) and `goal_update` (plan kind: outcome
condition, next step, reevaluate in N minutes, state `done` / `cancelled` / `intervention` with the user action).
Continuation turns (plan, watch follow-up, goal resume) carry the goal id; rule 66 tells the assistant to read the goal
and, when it cannot move it, to declare the intervention with what the person must do rather than end silently.

## Fixes in the same package

- Workflow result delivery (`chat/flow.ts`): only an **active** watch of the run suppresses the result card (a cancelled
  or expired watch no longer swallows it), as on the job path.

## Measurement

From the rows: goals per origin, `opened_at → closed_at`, time to first intervention (`intervention_at`), interventions
per goal, how goals end (`resolved_by`: `outcome`, `assistant`, `user`, `cancel`), follow-ups per goal; from
`chat_deliveries`: claims per delivery (`attempts`), expired claims (crash windows), `failed` reasons, claim → sent
latency. Both answer research questions 1 and 2 ("sessiz kalan hedefler", `follow_up = 'sent'` without a message).

## Security

Goals are the owner's own rows (user_id); routes check the signed-in user, tools the turn's user and conversation. Titles,
details and user actions are model / person text: plain, bounded; the card renders text only. "Vazgeç" cancels only the
goal and its active watches — jobs, runs and plans keep their own controls (a plan goal's "Vazgeç" is the plan's own
cancel). "Devam ettir" sends a system turn (`byUser: false`): its drafts stay cards unless the policy says otherwise.

## Rollback

Master only for the ledger and the outbox; the tools need worker 1.2.13 (older workers simply do not offer them).
Additive migrations: an older master never reads the tables. To remove: `DROP TABLE chat_goal_links, chat_goals,
chat_goal_ledger, chat_deliveries;`.

## Tests

- `apps/master/test/unit/goal-model.test.ts` — the assessment rules (pure).
- `apps/master/test/integration/chat-outcome.test.ts` — crashed service + watch cap → one intervention card and one
  notification; the assistant away past the reevaluate time → intervention; a plan continuation claimed then
  "crashed" → re-delivered after the lease, its orphan message removed, no second turn; a fenced slow sender; resume /
  cancel routes.
- `apps/master/test/integration/chat-flow.test.ts` — workflow run + cancelled watch → the result reaches the
  conversation.
- `apps/web/test/goal-needs.test.tsx` — the /needs intervention card and its actions.
