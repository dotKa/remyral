-- p14-workflow-engine 14.3 (ADR-0055, docs/design/p14-workflow-engine.md §19): worker function jobs.
-- Additive only. The `function-result.json` artifact of a function job (`spec.kind = "function"`) is stored as
-- job_artifacts kind `function` (redacted again by the master). The kinds are appended to whatever the constraint
-- allows now (another migration of the same release may add kinds too).
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
  kinds := kinds || ARRAY['function'];
  SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
  ALTER TABLE job_artifacts DROP CONSTRAINT job_artifacts_kind_check;
  EXECUTE format('ALTER TABLE job_artifacts ADD CONSTRAINT job_artifacts_kind_check CHECK (kind = ANY (%L::text[]))',
                 kinds);
END;
$$;
