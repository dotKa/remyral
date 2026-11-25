-- p10-chat-memory-suggestions (docs/design/p10-semantic-memory.md §13): project-linked chat feeds the project's Memory
-- suggestions inbox. Migration number 0082 (0081 = p10-semantic-defaults-chat; renumber at merge if a parallel change
-- took it).
--
-- The deterministic pass also reads chat messages that are shared with a project's knowledge (the deterministic links
-- of 0081 + every sharing switch + the project's capture, re-checked at query time) of projects whose memory mode is
-- not off. Provenance is the message (thread, seq, author, the thread's owner, when): reviewers are shown "from a
-- conversation of <user>, <date>" and a short snippet re-cut from the live message while it is still shared — never
-- the conversation. Additive only.

ALTER TABLE memory_suggestions
  -- The chat message a pass suggestion was read from (NULL: not from the chat pass, or the message was deleted).
  ADD COLUMN chat_message_id uuid NULL REFERENCES chat_messages (id) ON DELETE SET NULL,
  -- Its position in the thread; NOT NULL exactly for suggestions of the chat pass (suggest_memory leaves it NULL).
  ADD COLUMN chat_seq integer NULL CHECK (chat_seq IS NULL OR chat_seq >= 1),
  ADD COLUMN chat_author text NULL CHECK (chat_author IS NULL OR chat_author IN ('user', 'assistant')),
  -- Whose conversation it was (pass: the thread's owner; suggest_memory: the user who asked).
  ADD COLUMN chat_owner uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN chat_at timestamptz NULL,
  ADD CONSTRAINT memory_suggestions_chat_pass CHECK (chat_seq IS NULL OR (source = 'chat' AND chat_author IS NOT NULL));

-- The per-thread daily cap counts the pass's suggestions of a thread in the last 24 hours.
CREATE INDEX memory_suggestions_chat_thread ON memory_suggestions (thread_id, created_at)
  WHERE chat_seq IS NOT NULL;

-- Chat messages the pass has read for a project (idempotent: a message is read once per project).
CREATE TABLE memory_suggestion_chat_reads (
  message_id      uuid NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
  project         text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  thread_id       uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  processed_at    timestamptz NOT NULL,
  proposed        smallint NOT NULL DEFAULT 0,
  duplicates      smallint NOT NULL DEFAULT 0,
  skipped_secrets smallint NOT NULL DEFAULT 0,
  -- Candidates not proposed because the thread had reached its daily cap.
  rate_limited    smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, project)
);
CREATE INDEX memory_suggestion_chat_reads_thread ON memory_suggestion_chat_reads (thread_id);
