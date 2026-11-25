# Design note: `p15-chat-failover` — backup machines for the chat assistant

- **Task:** `p15-chat-failover`. **Date:** 2026-10-23. **Migration:** `0136_chat_failover.sql`.
- **Owner request:** "chat için yedek makine özelliği ekleyelim, fallback durumları yönetilebilsin."
- **Builds on:** p5-ops-chat (one assistant worker, history on the master), p5-ops-chat-next (replica bus, turn
  dispatch to the replica that holds the worker), p11-usage-limit-fallback (fallback engine on the same machine),
  p13-runtime-accounts / p15-message-delivery item 2 (fallback account, `auto`).
- **No new ADR:** no new trust boundary. Turns are signed for and sent to the chosen worker exactly as before; the
  master only decides *which* approved assistant worker gets the turn. No worker release is needed.

## 1. What was there

Settings → Chat names one worker (`chat_settings.worker_id`). The master keeps the whole conversation and sends it
with every turn (`#history`, `#sendStoredTurn`), so any assistant worker with the runtime and a login can answer any
thread. Before this change: primary offline → `worker_offline` ("chat is unavailable"); a disconnect while answering →
`assistant_disconnected`; turns left behind by a stopped master → `lost`. The only fallbacks were *on the same
machine* at a usage limit: fallback account (incl. `auto`), then fallback engine (`#usageLimited` →
`#continueOnFallback`).

## 2. The machine chain

`chat_settings.backup_worker_ids` — an ordered list (0–6) of approved workers after the primary. Saved with the rest of
Settings → Chat (admin, step-up, optimistic version, audited `chat.settings.update` with the list). Absent in a PUT =
unchanged (the classic page keeps working); the primary is never also a backup (a primary chosen from the list is
dropped from it; naming it explicitly in both is `400 backup_is_primary`); duplicates `400 backup_duplicate`;
unknown / unapproved `400 worker_not_found`.

A machine of the chain is **eligible** for a turn when, in this order (the first failure is its reason code):

| Check | Reason code |
| --- | --- |
| connected to this replica or to a live peer replica (`bus.ownerOf`) | `offline` |
| advertises `assistant-v1` (worker version new enough) | `update_required` |
| the local opt-out `assistant.disabled` is not set | `disabled_on_worker` |
| an engine plan exists (§3) | `engine_not_ready` / `engine_limited` |

Settings → Chat shows the same facts per machine (online, worker version, assistant feature, each engine's readiness
and reason as the machine reported it — "not logged in", "no API key", "not installed" — and whether the fallback
engine is there) and `GET /chat/failover` returns the master's verdict per chain machine.

## 3. Order of the fallbacks

**Machine first, then engine/account on that machine.** For each machine in `[pinned?, primary, ...backups]` the
master asks "can this machine answer now?" with the existing same-machine rules, and takes the first machine that can:

1. main engine with its account (primary: the configured account; backups: the machine's configured login / key —
   account ids are per machine, so the primary's account id means nothing elsewhere);
2. while that one is at its usage limit: the fallback account (primary: the chosen one or `auto`; backups: `auto`
   only when the setting is `auto`, otherwise none);
3. then the fallback engine on the same machine (same model profile rules);
4. none → the machine is not eligible (`engine_limited` / `engine_not_ready`) and the next machine is asked.

Why this order: the same-machine fallbacks already existed and keep a conversation on the machine whose runtime
session cache and login the owner chose; a usage limit is about a login, a disconnect is about a machine. A primary
whose engine and fallbacks are all limited now hands the turn to a backup instead of refusing it (`engine_limited`
only when no machine of the chain can answer). The main engine not being *ready* (no login, not installed) does not
fall to the fallback engine on that machine (unchanged p11 semantics: that one is for usage limits); it falls to the
next machine.

## 4. Routing and the stability period

Shared state: `chat_failover` (one row) — `auto` (automatic failover on), the pin (`pin_worker_id`, `pin_until`,
`pinned_by`) and the machine that answers now (`active_worker_id`, `active_reason`, `active_since`). Each turn:

- **Pin** active (until > now) and the pinned machine eligible → it answers (`pinned`). A pinned machine that is not
  eligible does not block the chat: the normal order follows (when automatic failover is on).
- **Automatic failover off** → only the primary (and the pin); nothing else is tried; the status says so.
- **Failed over** (the active machine is a backup and still eligible): an *earlier* machine of the chain (the primary
  first) takes over again only after it has been **connected without interruption for 60 s**
  (`FAILOVER_STABLE_MS`, from `workers.connected_at`, which every reconnect resets). Until then the backup keeps
  answering and the status says `primary_unstable` with the time it returns. 60 s covers a worker restart / update
  cycle and a flapping link without keeping the owner waiting long.
- Otherwise: the first eligible machine of the chain (no stability wait: a primary that just reconnected while the chat
  was not failed over answers at once — a master restart must not move the chat).

The answer's reason (status `routing.reason`): `primary`, `pinned`, `primary_offline`, `primary_unavailable` (online but
cannot answer: update, opt-out, engine not ready, limited), `primary_unstable`.

A change of the active machine is committed with a compare-and-set on `chat_failover` (one writer wins across
replicas) when a turn is routed and by the chat sweep (every 15 s) — so the return to the primary and the
notifications also happen when nobody chats. Each change is a `chat_failover_events` row (`failover` / `return`), an
audit event `chat.failover.switch` (actor system) and, for automatic switches, one `chat.failover` notification to
owners and admins (outbox; dedupe per event). Turns never produce notifications.

## 5. A machine lost while answering — re-run once

Causes that re-run: `assistant_disconnected` (the connection ended), `send_failed`, `timeout` (no news for the turn
timeout; the machine may still be connected but is excluded), and the machine-side refusals that mean "this machine
cannot run it" (`refused_disabled`, `refused_runtime_unavailable`, `runtime_not_configured`, `runtime_start_failed`,
`runtime_crashed`).

**Replay rule.** What an assistant turn can have done before it was lost: stream text (kept only in memory and in the
partial message), and call platform tools — the only way it acts. Tool kinds (`ASSISTANT_TOOLS[*].kind`): `read`
(no side effect), `draft` (stores a card; with direct execution — p15-autonomy / p15-chat-execute-default — it may
already have *run* the action: a job, a deploy, a settings change) and `notify` (a question card, a watch, a note sent).
The master records, per turn, every tool call it *received* (before running it). The turn is re-run only when:

1. no tool call other than `read` was received (a draft / notify call that may or may not have completed counts —
   at-least-once is not acceptable for actions), and
2. the user message was not re-run on another machine before (`chat_turns.rerun_of` — once per message, carried across
   replicas and through a later usage-limit continuation), and
3. another eligible machine exists (the lost machine is excluded for this re-run).

The re-run is a new turn (new id, `rerun_of` = the lost turn) for the same stored user message: history up to that
message, the message's attachments / mentions / context rebuilt as for a dispatched turn; the lost turn's partial text
is not sent. The thread gets the lost turn's error line ("… disconnected while answering. Continuing on mac-studio —
your message is answered there.") and a notice "build-01 bağlı değil; yanıt mac-studio'dan". When a non-read tool had
been called, the error line says the answer is **not** repeated automatically because it had already acted (N tool
calls) and the user should check the results above before sending again. An event `rerun` is logged and audited
(`chat.failover.rerun`).

Not re-run: a turn whose dispatch to a peer replica was never acknowledged (it stays `send_failed`, as before), and turns left open by a master process that stopped (`lost` by the sweep after twice the turn timeout) — the
replica that knew the turn and its tool calls is gone and a 12-minute-late answer would surprise; the user sees the
error and sends again. Cancelled turns and model failures (`model_error`, usage limits — those have their own rule).

## 6. Thread notices

When a turn goes to a machine other than the one that answered the thread's previous turn and either of them is not the
primary, the thread gets one notice (role `error`, `meta.notice = 'chat-failover'`, excluded from the model history,
rendered as a neutral line): "build-01 bağlı değil; yanıt mac-studio'dan" / "Yanıt yeniden build-01'den". Not on every
turn.

## 7. Managing it (admins, `chat.admin`)

`GET /chat/failover` — auto, pin, active machine + reason + since, the chain with each machine's verdict (eligible,
reason, engine plan, connected since, version), the last 20 events. Controls (CSRF, step-up, audited, an event each):

- `POST /chat/failover/primary` — "force back to primary": clears the pin and makes the primary the active machine at
  once (skips the stability wait). `409 primary_unavailable` (with the reason) when the primary cannot answer.
- `PUT /chat/failover/pin {workerId, minutes 15–10080}` / `DELETE /chat/failover/pin` — a chain machine answers first
  until the pin expires.
- `PUT /chat/failover/auto {enabled}` — automatic failover on / off.

Web: Ayarlar → Sohbet → "Yedek makineler" in the Asistan form (ordered list with readiness, add / remove / move) and a
new tab "Yedek geçişi" (state, controls, recent switches). The Sohbet header says which machine answers and why
("mac-studio · yedek — build-01 bağlı değil").

## 8. Status and assistant

`GET /chat/status` gains (additive) `primary` and `routing {machine, reason, position, pinned, auto, primaryIssue,
returnsAt}`; `worker` is now the machine that answers (the primary when none can). The chat tools: `list_workers`
and `get_settings` results carry `chatAssistant` (the same routing summary), so "sohbet hangi makinede?" works with the
deployed worker release; the `list_workers` / `get_settings` descriptions mention it (effective with the next worker
release, not required).

## 9. Several master replicas

Routing reads only shared state (database, `bus.ownerOf`). A turn routed to a machine held by a peer is dispatched as
before; the owner runs it, so the owner sees the disconnect and re-runs (it reads `rerun_of` from the turn row). The
compare-and-set keeps one transition per switch when several replicas sweep.

## 10. Security

No new credential path: the master signs each turn for the worker that gets it (as for the primary). Backups are
approved workers chosen by an admin with step-up; the pin can only name a chain machine. Every manual change is audited
with the actor; automatic switches are audited as `system`. Notification text is built from machine display names and
the master's own sentences.

## 11. Rollback

Additive. An older master ignores the new column and tables (chat goes to the primary only) and the notification kind
stays allowed by the widened constraint. To drop: `DROP TABLE chat_failover_events, chat_failover; ALTER TABLE
chat_settings DROP COLUMN backup_worker_ids; ALTER TABLE chat_turns DROP COLUMN rerun_of;` after deleting
`chat.failover` notifications / preferences.

## 12. Tests

Unit: route choice (order, pin, auto off, stability, exclusion). Master integration with real workers on fake engines
(`chat-failover.test.ts`): primary offline → backup answers with the notice; mid-turn disconnect → re-run once on the
backup; no replay after a non-read tool call; primary back → backup until 60 s, then primary (return notification);
pin / force / auto off (audited); usage limit on the primary with no fallback engine → backup; dispatch to a peer
replica. Web: settings list with readiness, state view and controls.
