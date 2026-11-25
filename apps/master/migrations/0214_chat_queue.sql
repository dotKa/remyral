-- p22-chat-queue (docs/design/p22-chat-queue.md): messages the person writes while the assistant is still answering
-- wait here ("Sırada") and are delivered together as the next turn when the running turn ends (any end).
--
--  * chat_queued_messages: one row per queued message of a conversation, in order (`ord`). `meta` is the message's
--    meta prepared when it was queued (mention chips resolved as the sender, credential chips, site / input upload
--    facts, time zone); `attachments` are the sender's pending uploads of the conversation (bound to the message row
--    on delivery). Delivery happens in ONE transaction that locks the conversation row, checks that no turn is open,
--    turns every queued row into its own chat_messages row, creates the turn and marks the rows `delivered` — so the
--    turn exists exactly when the rows are delivered (exactly once across concurrent turn ends, replicas, restarts).
--  * `hold_reason`: why the last delivery attempt waited (no machine can answer, a rate limit / budget); the sweep
--    tries again.
--
-- Additive. Rollback: an older master never reads the table (queued rows simply stay); to remove:
--   DROP TABLE chat_queued_messages;

CREATE TABLE chat_queued_messages (
  id           uuid PRIMARY KEY,
  ord          bigint GENERATED ALWAYS AS IDENTITY,
  thread_id    uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  content      text NOT NULL CHECK (length(content) <= 262144),
  meta         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(meta) = 'object'),
  attachments  uuid[] NOT NULL DEFAULT '{}',
  state        text NOT NULL CHECK (state IN ('queued', 'delivered', 'cancelled')),
  hold_reason  text NULL CHECK (hold_reason IS NULL OR hold_reason ~ '^[a-z_]{1,40}$'),
  message_id   uuid NULL,
  turn_id      uuid NULL,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  delivered_at timestamptz NULL,
  CHECK ((state = 'delivered') = (delivered_at IS NOT NULL))
);
CREATE INDEX chat_queued_messages_thread_idx ON chat_queued_messages (thread_id, ord) WHERE state = 'queued';
