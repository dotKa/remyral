-- p9-chat-unread (docs/design/p9-chat-unread.md): per user, per conversation read position, so the conversation list
-- can show which conversations have unread messages. Migration number 0074: renumber at merge if a parallel change
-- took it. Rows are written only through src/chat/store.ts (POST /chat/threads/:id/read, /chat/threads/read-all).
--
-- Unread = messages after `last_read_seq` whose role is 'assistant' (answers, watch / deploy / report notes) or 'error'
-- (a failed answer). The user's own messages and tool lines never count. Threads are private to their owner today;
-- the key is (thread, user) so a later shared thread keeps one read position per reader.
CREATE TABLE chat_thread_reads (
  thread_id      uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The highest message seq the user has seen in this thread (0: nothing yet). Only ever moves forward.
  last_read_seq  integer NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
  -- When last_read_seq last moved forward.
  last_read_at   timestamptz NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX chat_thread_reads_user ON chat_thread_reads (user_id);

-- Counting unread rows is an index range scan over (thread_id, seq > last_read_seq) restricted to the counted roles.
CREATE INDEX chat_messages_unread ON chat_messages (thread_id, seq) WHERE role IN ('assistant', 'error');

-- Existing conversations start fully read: no flood of "unread" badges right after the deploy.
INSERT INTO chat_thread_reads (thread_id, user_id, last_read_seq, last_read_at)
SELECT id, user_id, next_seq - 1, now() FROM chat_threads;
