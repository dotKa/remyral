-- p18-leftovers (docs/design/p18-leftovers.md item 4; docs/design/p18-plan-mode.md "Leftovers"): plan texts in the
-- meaning search of the owner's conversations (`GET /chat/search`).
--
--  * chat_plan_embeddings: vectors of a plan's text (title, goal, phase and item titles and details — never a decision
--    answer or a note) for its owner only, like chat_embeddings scope 'user'. Redacted before embedding; chunks that
--    still look secret are skipped. Only while the owner indexes their conversations (chat_search_prefs).
--  * chat_plans.search_synced_at: the plan's last indexing (the chat pass re-indexes a plan whose updated_at is newer).
--
-- Additive. Rollback: an older master ignores the table and the column (plans are then found by keywords only, as
-- before); to remove: DROP TABLE chat_plan_embeddings; ALTER TABLE chat_plans DROP COLUMN search_synced_at;

CREATE TABLE chat_plan_embeddings (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  thread_id     uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  plan_id       uuid NOT NULL REFERENCES chat_plans (id) ON DELETE CASCADE,
  chunk         smallint NOT NULL CHECK (chunk BETWEEN 0 AND 63),
  -- sha256 of the exact (redacted) text that was embedded — never the text itself.
  content_hash  text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  model         text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  dims          integer NOT NULL CHECK (dims BETWEEN 1 AND 8192),
  embedding     real[] NOT NULL CHECK (cardinality(embedding) = dims AND array_ndims(embedding) = 1),
  indexed_at    timestamptz NOT NULL,
  UNIQUE (plan_id, chunk)
);
CREATE INDEX chat_plan_embeddings_user_idx ON chat_plan_embeddings (user_id, model);
CREATE INDEX chat_plan_embeddings_thread_idx ON chat_plan_embeddings (thread_id);

ALTER TABLE chat_plans ADD COLUMN search_synced_at timestamptz NULL;
CREATE INDEX chat_plans_search_pending_idx ON chat_plans (updated_at)
  WHERE search_synced_at IS NULL OR search_synced_at < updated_at;
