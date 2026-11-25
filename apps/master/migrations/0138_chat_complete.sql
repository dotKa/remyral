-- p16-chat-complete (docs/design/p16-chat-complete.md): edit / regenerate / retry, the restart re-run and sharing of
-- conversations. Additive only.
--
--  * chat_messages.superseded_at / superseded_by: a row replaced by an edit (by = the edited message's new row) or by a
--    regenerate / retry (by = the new turn). Superseded rows never reach a model again; the console folds them.
--  * chat_turns.message_id: the user message the turn answers (edit / regenerate find the turns they replace).
--  * chat_turns.actions: non-read tool calls received (p15-chat-failover's replay rule, now persisted: a restart and
--    every replica see it).
--  * chat_turns.runner: the replica (process) that sends the turn to its worker — an open turn of a stopped runner is
--    an orphan the restart recovery may re-run once.
--  * chat_turns.origin: regenerate | retry | edit | restart (NULL: a plain message).
--  * chat_thread_shares: read-only readers of a conversation (the owner adds / removes them).
--
-- Rollback: an older master ignores all of it. To remove:
--   DROP TABLE chat_thread_shares;
--   ALTER TABLE chat_messages DROP COLUMN superseded_at, DROP COLUMN superseded_by;
--   ALTER TABLE chat_turns DROP COLUMN message_id, DROP COLUMN actions, DROP COLUMN runner, DROP COLUMN origin;
-- Migration number 0138 (0137 is the last on main at writing; a parallel change may take it — renumber at merge).

ALTER TABLE chat_messages
  ADD COLUMN superseded_at timestamptz NULL,
  ADD COLUMN superseded_by uuid NULL,
  ADD CONSTRAINT chat_messages_superseded_pair CHECK ((superseded_at IS NULL) = (superseded_by IS NULL));

ALTER TABLE chat_turns
  ADD COLUMN message_id uuid NULL,
  ADD COLUMN actions integer NOT NULL DEFAULT 0 CHECK (actions >= 0),
  ADD COLUMN runner text NULL CHECK (runner IS NULL OR length(runner) <= 64),
  ADD COLUMN origin text NULL CHECK (origin IS NULL OR origin IN ('regenerate', 'retry', 'edit', 'restart'));
CREATE INDEX chat_turns_message ON chat_turns (message_id) WHERE message_id IS NOT NULL;

CREATE TABLE chat_thread_shares (
  thread_id   uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  granted_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX chat_thread_shares_user ON chat_thread_shares (user_id, created_at DESC);
