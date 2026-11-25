-- oss-sec3 (owner decision 2026-11-24: "sorabilir; sonrasında hafızaya göre devam eder"): a chat turn that has read
-- content from outside the person — a job log or output, a repository file or diff, a web response, an attachment,
-- a machine's command output — no longer runs the assistant's drafts at once: they stay the usual confirmation card.
-- When the person confirms such a card they may let the platform remember that kind of action on that target, so the
-- same thing is not asked again. ADR-0056, amendment 2026-11-24 (untrusted content).
--
--  * chat_turns.tainted_at      when the turn first read untrusted content (or started from it); a system-written
--                               continuation turn of the conversation (plan, watch follow-up, late tool result, goal)
--                               inherits it from any earlier turn of the same conversation
--  * chat_turns.taint_sources   the tools / inputs that tainted it (audit and support; names only, no content)
--  * chat_drafts.held           'untrusted_content': the draft would have run at once but the turn was tainted
--  * chat_untrusted_allows      the person's remembered choices (user-scoped; action + target; revocable)
--
-- No foreign keys on chat rows (thread, draft, turn): see 0200 / 0206.
--
-- Additive. Rollback: an older master never reads the columns or the table (drafts run as before); to remove:
--   DROP TABLE chat_untrusted_allows;
--   ALTER TABLE chat_drafts DROP COLUMN held;
--   ALTER TABLE chat_turns DROP COLUMN taint_sources, DROP COLUMN tainted_at;

ALTER TABLE chat_turns
  ADD COLUMN tainted_at timestamptz NULL,
  ADD COLUMN taint_sources text[] NULL CHECK (taint_sources IS NULL OR cardinality(taint_sources) <= 32);
CREATE INDEX chat_turns_tainted ON chat_turns (thread_id) WHERE tainted_at IS NOT NULL;

ALTER TABLE chat_drafts
  ADD COLUMN held text NULL CHECK (held IS NULL OR held IN ('untrusted_content'));

CREATE TABLE chat_untrusted_allows (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  action      text NOT NULL CHECK (action ~ '^[a-z0-9_.:-]{1,80}$'),
  target      text NOT NULL CHECK (char_length(target) <= 400),
  label       text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 300),
  draft_id    uuid NULL,
  thread_id   uuid NULL,
  created_at  timestamptz NOT NULL,
  revoked_at  timestamptz NULL
);
CREATE UNIQUE INDEX chat_untrusted_allows_live ON chat_untrusted_allows (user_id, action, target)
  WHERE revoked_at IS NULL;
