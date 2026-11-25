-- p17-auto-learning (docs/design/p17-auto-learning.md, ADR-0043 amendment 2026-10-24): tiered automatic acceptance of
-- memory suggestions, merging near-duplicate suggestions, and a daily "N new things learned" digest.
--
--  * memory_suggestion_settings.auto_learn: per project `off` / `safe` (the default, also for every existing project) /
--    `all`. Changed by a project admin with a fresh step-up (audited `memory.suggestions.auto_learn`). A project
--    without a settings row is `safe` too.
--  * memory_suggestions: a new state `merged` (folded into another suggestion — `merged_into` — or into an active
--    record that already says it — `merged_doc_id`), the merged sources as evidence, the auto-learning verdict
--    (outcome, reasons, policy version, when), the suggestion's own vector (consented projects only, like
--    search_embeddings: a vector, never sent anywhere) and "Geri al" (undone_at / undone_by).
--  * memory_records.auto_learned: provenance of a record the system accepted (policy version, reasons, confidence,
--    sources, when). NULL for everything a person accepted or wrote.
--  * memory_autolearn_digests: one digest per project and day (idempotent across master replicas).
--  * notification kind 'memory.auto_learned'.
--
-- Additive. Rollback: an older master ignores the new columns; `merged` rows are not `pending`, so they stay out of
-- its inbox. To remove the notification kind's rows: DELETE FROM notifications WHERE kind = 'memory.auto_learned';
-- DELETE FROM notification_preferences WHERE kind = 'memory.auto_learned'.

ALTER TABLE memory_suggestion_settings
  ADD COLUMN auto_learn text NOT NULL DEFAULT 'safe' CHECK (auto_learn IN ('off', 'safe', 'all')),
  ADD COLUMN auto_learn_updated_at timestamptz NULL,
  ADD COLUMN auto_learn_updated_by uuid NULL REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE memory_suggestions DROP CONSTRAINT memory_suggestions_state_check;
ALTER TABLE memory_suggestions ADD CONSTRAINT memory_suggestions_state_check
  CHECK (state IN ('pending', 'accepted', 'dismissed', 'merged'));

ALTER TABLE memory_suggestions
  -- The suggestion this one was folded into (it keeps the better-written text and lists this one as evidence).
  ADD COLUMN merged_into uuid NULL REFERENCES memory_suggestions (id) ON DELETE SET NULL,
  -- Or the active record that already says the same.
  ADD COLUMN merged_doc_id uuid NULL REFERENCES context_documents (id) ON DELETE SET NULL,
  -- [{suggestionId, jobId?, threadId?, chatMessageId?, title}] — the suggestions merged into this one.
  ADD COLUMN evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  -- The auto-learning verdict: accepted / expiring (accepted with a short expiry) / human (left for a person) /
  -- merged. NULL: never evaluated (older rows, or auto-learning off).
  ADD COLUMN auto_outcome text NULL CHECK (auto_outcome IS NULL OR auto_outcome IN ('accepted', 'expiring', 'human', 'merged')),
  ADD COLUMN auto_reasons text[] NOT NULL DEFAULT '{}' CHECK (cardinality(auto_reasons) <= 20),
  ADD COLUMN auto_policy smallint NULL CHECK (auto_policy IS NULL OR auto_policy >= 1),
  ADD COLUMN auto_at timestamptz NULL,
  -- Accepted by the system (auto-learning), not by a person.
  ADD COLUMN auto_accepted boolean NOT NULL DEFAULT false,
  -- Included in an owners' digest.
  ADD COLUMN digested_at timestamptz NULL,
  -- "Geri al": the auto-accepted record was rejected by a person (the history stays).
  ADD COLUMN undone_at timestamptz NULL,
  ADD COLUMN undone_by uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  -- The text's vector (only for projects whose search capture is consented; `embedding_model` names the space).
  ADD COLUMN embedding real[] NULL CHECK (embedding IS NULL OR (array_ndims(embedding) = 1 AND cardinality(embedding) BETWEEN 1 AND 4096)),
  ADD COLUMN embedding_model text NULL CHECK (embedding_model IS NULL OR length(embedding_model) <= 200),
  ADD CONSTRAINT memory_suggestions_auto_shape CHECK (NOT auto_accepted OR state = 'accepted'),
  ADD CONSTRAINT memory_suggestions_undo_shape CHECK (undone_at IS NULL OR auto_accepted);

CREATE INDEX memory_suggestions_auto ON memory_suggestions (project, decided_at DESC) WHERE auto_accepted;
CREATE INDEX memory_suggestions_undigested ON memory_suggestions (project) WHERE auto_accepted AND digested_at IS NULL;
CREATE INDEX memory_suggestions_merged_into ON memory_suggestions (merged_into) WHERE merged_into IS NOT NULL;

ALTER TABLE memory_records
  -- {policyVersion, reasons[], confidence, sources, at}: accepted by the auto-learning policy (NULL: by a person).
  ADD COLUMN auto_learned jsonb NULL CHECK (auto_learned IS NULL OR jsonb_typeof(auto_learned) = 'object');

CREATE TABLE memory_autolearn_digests (
  project     text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  day         date NOT NULL,
  items       integer NOT NULL CHECK (items >= 0),
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (project, day)
);

-- Widening a closed CHECK list keeps every value an earlier migration allowed.
CREATE FUNCTION pg_temp.widen_check_0152(t text, c text, col text, extra text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  def text;
  vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = c AND conrelid = t::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint % not found', c;
  END IF;
  -- Either `col = ANY ('{a,b}'::text[])` (written by an earlier widening) or `col IN ('a', 'b')`.
  IF def ~ '\{' THEN
    vals := string_to_array(substring(def from '\{([^}]*)\}'), ',');
  ELSE
    SELECT array_agg(DISTINCT m[1]) INTO vals FROM regexp_matches(def, '''([A-Za-z0-9_.:-]+)''', 'g') AS m;
  END IF;
  IF coalesce(array_length(vals, 1), 0) < 2 THEN
    RAISE EXCEPTION 'could not read the values of %', c;
  END IF;
  vals := vals || extra;
  SELECT array_agg(DISTINCT v ORDER BY v) INTO vals FROM unnest(vals) AS v;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I = ANY (%L::text[]))', t, c, col, vals);
END
$$;

SELECT pg_temp.widen_check_0152('notifications', 'notifications_kind_check', 'kind', ARRAY['memory.auto_learned']);
SELECT pg_temp.widen_check_0152('notification_preferences', 'notification_preferences_kind_check', 'kind',
                                ARRAY['memory.auto_learned']);
