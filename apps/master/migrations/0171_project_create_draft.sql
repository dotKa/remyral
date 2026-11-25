-- p17-chat-github Part 2 (docs/design/p17-chat-github.md §2): creating a project from the chat.
--
--  * chat_drafts.kind + 'project_create': the assistant's confirm card (draft_project_create) — the project, its
--    optional repository link (through a connected GitHub App) and DNS zone; created only when confirmed.
--  * projects.description: a short description (≤ 500 characters) — set from the chat card or POST /projects.
--
-- Additive. Rollback: an older master ignores the column and never lists such cards; to remove:
--   DELETE FROM chat_drafts WHERE kind = 'project_create'; ALTER TABLE projects DROP COLUMN description;

ALTER TABLE projects
  ADD COLUMN description text NULL CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 500);

-- Widening a closed CHECK list keeps every value an earlier migration allowed.
CREATE FUNCTION pg_temp.widen_check_0171(t text, c text, col text, extra text[]) RETURNS void
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

SELECT pg_temp.widen_check_0171('chat_drafts', 'chat_drafts_kind_check', 'kind', ARRAY['project_create']);
