-- p13-workflows-ui (docs/design/p13-workflows-ui.md): the assistant may draft a workflow definition (a new workflow or
-- a new version of an existing one); the user confirms the card. Chat draft kind `workflow`, appended to whatever the
-- constraint allows now (other migrations of the same release may add kinds too). Additive; rollback = leave it.

DO $$
DECLARE
  def text;
  kinds text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'chat_drafts_kind_check' AND conrelid = 'chat_drafts'::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint chat_drafts_kind_check not found';
  END IF;
  IF def ~ '\{' THEN
    kinds := string_to_array(substring(def from '\{([^}]*)\}'), ',');
  ELSE
    SELECT array_agg(DISTINCT m[1]) INTO kinds FROM regexp_matches(def, '''([a-z0-9_]+)''', 'g') AS m;
  END IF;
  IF coalesce(array_length(kinds, 1), 0) < 2 THEN
    RAISE EXCEPTION 'could not read the kinds of chat_drafts_kind_check';
  END IF;
  kinds := kinds || ARRAY['workflow'];
  SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
  ALTER TABLE chat_drafts DROP CONSTRAINT chat_drafts_kind_check;
  EXECUTE format('ALTER TABLE chat_drafts ADD CONSTRAINT chat_drafts_kind_check CHECK (kind = ANY (%L::text[]))', kinds);
END;
$$;
