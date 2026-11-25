# Design note: `p22-chat-queue` — messages written while Remyral answers wait and go with the next turn

- **Task:** `p22-chat-queue`. **Date:** 2026-11-01. **Migration:** `0214_chat_queue.sql`.
- **Owner request (2026-11-01):** "chat te mesaj gönderiyorum remyral yazıyor, yazarken bir şeyler daha yazıp göndermek
  istiyorum ama buton disabled. claude deki gibi mesaj queue edilebilir."
- **Builds on:** p5-ops-chat (one turn per conversation; `409 turn_in_progress`), p15-chat-failover / p11-usage-limit-
  fallback (a turn continued by a successor turn for the same message), p16-chat-complete (restart recovery, the stored
  turn send), p17-chat-reconnect (a held turn stays open), p20-outcome (`chat_deliveries`: the "the turn exists exactly
  when it was delivered" pattern this note reuses).
- **No new ADR:** no new trust boundary. The queue holds the owner's own messages of the owner's own conversation; the
  delivered turn is the same turn a composer send would have started (rate limit and budgets apply, drafts follow the
  autonomy policy as for any message the person wrote).
- **No worker change.** Master + web only.

## 1. Before

The composer's send button was disabled while a turn ran (`busy = turnOpen` in `DiyalogChat.tsx`), and the master
refused a second message with `409 turn_in_progress`. The person had to wait, keep the text somewhere, and send it
after the answer.

## 2. Behaviour

- While the assistant answers, the send button stays enabled; its label is "Sıraya ekle" / "Add to queue" and its
  tooltip (and the hint line under the composer) say the message waits for the answer to end. Enter queues as well. The
  Stop button stays as before. The composer clears after queueing.
- The queued message appears at once under the answer being written as a dimmed bubble marked **Sırada / Queued**, with
  **Düzenle** (edit the text), **Kaldır** (it is never sent) and, while the answer runs, **Şimdi gönder** — which is the
  existing Stop (`POST /chat/threads/:id/cancel`): the turn ends cancelled and what waited is delivered at once.
- When the turn ends — **any** end: done, failed, stopped, timed out, lost — every waiting message of the conversation is
  delivered together, like Claude Code: each becomes its own user message row (its own bubble, in order, after the
  answer that was being written), and ONE turn answers them; its model input is their texts in order, one paragraph each.
- The queue lives on the master: a reload, another tab or the phone (same component, PWA) shows the same bubbles.
- At most 20 messages wait per conversation (`409 queue_full`).

## 3. Data (migration 0214)

`chat_queued_messages` — one row per waiting message: `id`, `ord` (identity: the order), `thread_id`, `user_id`,
`content` (scrubbed like a sent message), `meta` (prepared when queued: mention chips resolved as the sender, credential
chips, site / input upload facts, archives, time zone, `origin: 'user'`), `attachments` (the sender's unsent uploads of
the conversation, checked when queued, bound to the message row on delivery), `state` (`queued` / `delivered` /
`cancelled`), `hold_reason` (why the last delivery attempt waited), `message_id` / `turn_id` (what it became),
timestamps. Partial index on `(thread_id, ord) WHERE state = 'queued'`.

Why a table and not a flag on `chat_messages`: a dozen readers (history, search, exports, sharing, memory suggestions,
unread counters, restart recovery's "last user message") would have to learn to skip waiting rows, and their `seq` would
sit before the answer being written. Waiting rows become messages only when they are delivered, so every reader stays
unchanged and the rows land after the answer.

## 4. API

- `POST /chat/threads/:id/messages` gains `queue: boolean` (optional). With `queue: true`, while a turn of the
  conversation runs (or messages already wait) the answer is `202 { queued, dropped }` instead of
  `{ message, turnId, dropped }`; otherwise it is the usual send. Without `queue` nothing changes (`409
  turn_in_progress`) — older consoles and every other caller keep their behaviour.
- `GET /chat/threads/:id` gains `queued` (owner only; a shared reader never sees it).
- `PATCH /chat/threads/:id/queued/:queuedId {text}` and `DELETE /chat/threads/:id/queued/:queuedId` — the caller's
  own waiting message; `409 message_not_queued` once it was delivered or removed.
- Stream event `queue` (`{change, ids, turnId?}`, ids only; a shared reader gets the bare signal) — the console reads
  the conversation again. Older consoles ignore it.

Which messages queue (`ChatService.post`): only a plain composer message (`byUser`, no edit, no "Sohbette düzenle"
card edit, no question answer, no workflow panel, no system continuation). `post` tries the normal `send` first; a
`turn_in_progress` refusal (the check `send` already makes, before any side effect) turns into a queued row.

## 5. System / automated callers — unchanged on purpose

Goals (`goals.ts`), plan continuations (`plans.ts`), the share hand-over (`share.ts`), watch follow-ups and question
answers keep calling `send` directly and keep the 409: they already have their own retry with a leased, fenced delivery
(`chat_deliveries`, p20-outcome) or a card that keeps the choice. Queuing them would mix a system-written turn into the
person's batch (its drafts would become `byUser` turns) and break their idempotency keys. A continuation released on
`turn_in_progress` simply comes back on its owner's next pass; it may run before or after a queued batch — both are
fine, the drain waits for whatever turn is open.

## 6. Delivery — exactly once

`ChatService.#drain(threadId)`:

1. Route (the answering machine as for any turn). No machine → the rows get `hold_reason = assistant_unavailable`.
2. ONE transaction: lock the conversation row (`SELECT … FROM chat_threads … FOR UPDATE` — the queue insert takes the same
   lock), check that no turn of the conversation is open (`sent` / `running`, within the turn timeout, as `send`
   decides), lock the waiting rows in order (`FOR UPDATE`), apply the per-turn rate limit and budgets once for the
   batch (a refusal → `hold_reason`, nothing changes), then for each row: add the user message (meta + bound files +
   `queued: true`; the last one also `queuedWith: [earlier ids]`), bind its attachments / site / input uploads, mark the
   row `delivered` (fenced: `WHERE state = 'queued'`); finally create the `chat_turns` row for the last message.
   The turn exists exactly when the rows are delivered.
3. After commit: the turn is sent like a stored / dispatched turn (`#sendStoredTurn`, or the replica bus when another
   replica owns the machine's connection).

Concurrency: two end handlers, two replicas or a handler and the sweep serialise on the conversation lock; the second
finds the new turn open, or nothing waiting, and does nothing. A process that dies after the commit leaves an open turn
row — the existing restart recovery re-runs it (it answers the batch again: §7). A process that dies before the commit
leaves the rows waiting — the sweep delivers them.

Triggers:

- `#record` (every recorded end) calls the drain in a `finally`, after the end's own rows (the answer, the error line)
  are written, so delivered rows follow them. Ends whose message is answered again by a successor turn (failover re-run,
  usage-limit fallback) pass `continues: true` and drain after the successor started (a no-op while it runs; its own end
  delivers).
- `#enqueue`: when no turn is open any more by the time the row is stored (the turn ended in between).
- The chat sweep (every 15 s): `drainQueues()` — conversations with waiting rows, no open turn and no turn ended in the
  last 10 s (`QUEUE_QUIET_MS`: a turn whose end is followed by a re-run gets its successor first). This covers a master
  restart, an end recorded without `#record` (restart recovery, stale-turn sweep) and held deliveries.

## 7. The batch turn's input

`#sendStoredTurn` reads `meta.queuedWith` of the turn's message: the earlier rows lead the input (`batchText`: each
row's text — or its "(The user sent attachments …)" line — joined by a blank line), the history ends before the first
of them, and the turn's extras (attachments the worker may fetch, mention blocks, site / input upload blocks) are the
union over the batch. Because the batch is stored on the message, a failover re-run, a usage-limit fallback, a restart
re-run and a dispatch to another replica answer the same batch. The delivered turn has no step-up (as a dispatched turn):
direct actions that need a fresh code become cards.

## 8. Web

- `Composer` gets `queue` (only `DiyalogChat` passes it): while `busy`, the send is not blocked; label, tooltip and hint
  say it is queued (`home.composer.queue`, `queueHint`).
- `DiyalogChat.tsx` (kept small: another change touches its accessibility attributes): `queue` on the composer, no
  "Gönderiliyor…" flying bubble while a turn is open (the message does not join the thread), and the new
  `QueuedMessages` under the thread (owner only).
- `useOpsChat` sends with `queue: true` and re-reads on the `queue` stream event.
- Strings: `chatQueue` catalog (TR + EN), `errors.queue_full`, `errors.message_not_queued`.
- Mobile / PWA: the same component; the bubbles use the thread's max width, buttons are at least 36 px (44 px on touch
  for the action links).

## 9. Security

- Only the conversation's owner queues, reads, edits or removes (`store.thread(userId, …)` on every path; rows also
  carry `user_id`). A shared reader sees no queue (the detail's reader branch never includes it; stream events are a bare
  signal for readers).
- The text is scrubbed (`scrubUserText`) on queue and on edit; credential tokens become chips, never values.
- Mentions are resolved as the sender when queued and their blocks again as the sender when sent; attachments must be
  the sender's own unsent uploads of the conversation (checked when queued and again, under lock, when delivered).
- Audit: `chat.message.queued` (who, conversation, file count), `chat.message.queue_delivered` (turn, how many).
- No looser default: the delivered turn is a person's message under the same rate limit, budgets and autonomy policy.

## 10. Rollback

Master revert: the table stays unused (waiting rows are never delivered — at most 20 per conversation; they can be
removed with `DELETE FROM chat_queued_messages WHERE state = 'queued'`). Web revert: the button is disabled while busy
again. To remove the table: `DROP TABLE chat_queued_messages;`.

## 11. Measurement

From the rows: messages queued per conversation, `created_at → delivered_at` (wait time), batch size per turn
(`count(*) GROUP BY turn_id`), removed before delivery (`state = 'cancelled'`), `hold_reason` frequency.

## 12. Tests

- `apps/master/test/integration/chat-queue.test.ts` (Postgres; real worker transport, fake engine): queue during a turn
  (and the unchanged 409 without `queue`); two queued messages delivered as one turn after it (rows in order after the
  answer, input `second\n\nthird`, one turn, audit); edit and remove before delivery, `409 message_not_queued` after;
  Stop delivers what waited; exactly once under three concurrent drains; the sweep after a "restart" waits the quiet
  window, then delivers.
- `apps/web/test/chat-queue.test.tsx`: the send button stays enabled while Remyral answers (label + tooltip), Enter
  posts `queue: true` and clears the field, the "Sırada" bubble shows under the answer (not in the thread), "Şimdi
  gönder" stops the answer, "Kaldır" removes it.

## Changelog

- feat(master,web,i18n): **a message written while Remyral answers is queued instead of refused: the send button stays enabled, the message shows as a "Sırada" bubble (edit / remove / send now) and, when the answer ends, everything that waited goes as one turn** (p22-chat-queue, [design](p22-chat-queue.md); owner 2026-11-01: "yazarken bir şeyler daha yazıp göndermek istiyorum ama buton disabled. claude deki gibi mesaj queue edilebilir"). The queue is server-side (migration 0214 `chat_queued_messages`, survives a reload and shows on every device); any turn end (done, failed, stopped, lost) delivers it exactly once in one transaction under the conversation row lock — each message its own row after the answer, one turn whose input is their texts in order — and the chat sweep picks up what a restart left waiting. `POST /chat/threads/:id/messages` takes `queue: true` (without it: the unchanged 409); goals, plan continuations, share and watch follow-ups keep their 409 and their own retry.
