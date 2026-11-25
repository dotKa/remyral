-- p17-disk-selfclean (docs/design/p17-disk-selfclean.md): the worker frees its own disk space when it runs low.
--
--  * workers.disk_hygiene / disk_hygiene_at: CAPABILITIES.diskHygiene (on / off, threshold and target, the last run with
--    the bytes freed per category, the next runs, and — when space stayed low — the sizes of the top-level directories
--    of the worker's data dir and workspace root). Shown on the machine page and by the doctor.
--  * worker_ops.kind + 'disk.clean' (remote op "Şimdi temizle", audited as worker.ops.disk.clean).
--
-- Additive. Rollback: an older master ignores the columns; to remove them:
--   DELETE FROM worker_ops WHERE kind = 'disk.clean';
--   ALTER TABLE workers DROP COLUMN disk_hygiene, DROP COLUMN disk_hygiene_at;
-- Migration number 0158 (0157_object_storage_rest is on main; renumber at merge if a parallel change takes it).

ALTER TABLE workers
  ADD COLUMN disk_hygiene jsonb NULL,
  ADD COLUMN disk_hygiene_at timestamptz NULL;

-- Widening a closed CHECK list keeps every value an earlier migration allowed.
CREATE FUNCTION pg_temp.widen_check_0158(t text, c text, col text, extra text[]) RETURNS void
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

SELECT pg_temp.widen_check_0158('worker_ops', 'worker_ops_kind_check', 'kind', ARRAY['disk.clean']);
