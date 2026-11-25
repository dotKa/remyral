-- p17-worker-managed Part 2 (docs/design/p17-worker-managed.md §2): the worker's local settings managed from the panel
-- travel in the existing configuration generations (`spec.settings` / `document.settings`, jsonb — no column change).
-- Runtime executable paths change only through their own owner-only route, recorded with a cause of its own:
--
--  * worker_config_versions.cause: + runtime_paths.
--
-- Additive. Rollback: an older master never writes the cause (it reads such generations like any other); to remove
-- it, re-create worker_config_versions_cause_check without it (same block as below) once no row uses it.
DO $$
DECLARE
  def text;
  causes text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'worker_config_versions_cause_check' AND conrelid = 'worker_config_versions'::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint worker_config_versions_cause_check not found';
  END IF;
  IF def ~ '\{' THEN
    causes := string_to_array(substring(def from '\{([^}]*)\}'), ',');
  ELSE
    SELECT array_agg(DISTINCT m[1]) INTO causes FROM regexp_matches(def, '''([a-z0-9_]+)''', 'g') AS m;
  END IF;
  IF coalesce(array_length(causes, 1), 0) < 2 THEN
    RAISE EXCEPTION 'could not read the causes of worker_config_versions_cause_check';
  END IF;
  causes := causes || ARRAY['runtime_paths'];
  SELECT array_agg(DISTINCT k ORDER BY k) INTO causes FROM unnest(causes) AS k;
  ALTER TABLE worker_config_versions DROP CONSTRAINT worker_config_versions_cause_check;
  EXECUTE format('ALTER TABLE worker_config_versions ADD CONSTRAINT worker_config_versions_cause_check CHECK (cause = ANY (%L::text[]))', causes);
END;
$$;
