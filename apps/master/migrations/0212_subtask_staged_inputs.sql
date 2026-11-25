-- p22-previews-inputs (docs/design/p22-previews-inputs.md §4): sub-job inputs above the inline limit are staged as
-- artifacts of the requesting attempt (ARTIFACT_CHUNK / ARTIFACT_REF `ws-subin-…`) and stored as job_artifacts kind
-- `subtask-input` (never listed as outputs, never served). Additive only: the kind is appended to whatever the
-- constraint allows now (another migration of the same release may add kinds too).
-- Rollback: delete the rows of kind `subtask-input` first, then re-create the constraint without it.
DO $$
DECLARE
  def text;
  kinds text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'job_artifacts_kind_check' AND conrelid = 'job_artifacts'::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint job_artifacts_kind_check not found';
  END IF;
  IF def ~ '\{' THEN
    kinds := string_to_array(substring(def from '\{([^}]*)\}'), ',');
  ELSE
    SELECT array_agg(DISTINCT m[1]) INTO kinds FROM regexp_matches(def, '''([a-z0-9-]+)''', 'g') AS m;
  END IF;
  IF coalesce(array_length(kinds, 1), 0) < 2 THEN
    RAISE EXCEPTION 'could not read the kinds of job_artifacts_kind_check';
  END IF;
  kinds := kinds || ARRAY['subtask-input'];
  SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
  ALTER TABLE job_artifacts DROP CONSTRAINT job_artifacts_kind_check;
  EXECUTE format('ALTER TABLE job_artifacts ADD CONSTRAINT job_artifacts_kind_check CHECK (kind = ANY (%L::text[]))',
                 kinds);
END;
$$;
