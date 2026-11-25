-- p17-chat-github Part 1 (docs/design/p17-chat-github.md §1): where a conversation's title comes from, so the assistant
-- can name it from its meaning once (or, after a greeting-only start, once more after 3–5 messages) and never overwrite
-- a title a person set.
--
--   default      "New conversation" (nothing sent yet)
--   placeholder  the first words of the first message; the assistant is asked for a title from its meaning
--   provisional  the first message said too little (a greeting, one word, only a file); retitled once after 3–5 messages
--   auto         named by the assistant — no further automatic change
--   user         set by a person (rename) or given when the conversation was created — never changed automatically
--
-- Existing conversations count as `user` (no automatic change to old titles) except the ones still unnamed.
-- Additive. Rollback: an older master ignores the column; to remove: ALTER TABLE chat_threads DROP COLUMN title_source.

ALTER TABLE chat_threads
  ADD COLUMN title_source text NOT NULL DEFAULT 'user'
    CONSTRAINT chat_threads_title_source_check
    CHECK (title_source IN ('default', 'placeholder', 'provisional', 'auto', 'user'));

UPDATE chat_threads SET title_source = 'default' WHERE title = 'New conversation';

ALTER TABLE chat_threads ALTER COLUMN title_source SET DEFAULT 'default';
