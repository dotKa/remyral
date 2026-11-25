-- p17-worker-managed Parts 3 and 4 (docs/design/p17-worker-managed.md §3, §4): removing a worker from the panel and
-- managing its machine-admin helper.
--
--  * worker_removals: one removal request per machine at a time — `purge` (also the config, data dir with the device key
--    and the service user), the remote operation that carries it, its state and outcome. An offline machine keeps the
--    request (state `requested`) and gets the signed `worker.uninstall` when it connects; the worker is revoked once
--    the privileged helper accepted it (`done`). A refusal / failure keeps the worker (the panel shows the manual
--    uninstall and "Revoke now").
--  * worker_ops.kind + 'worker.uninstall', 'helper.manage' (audited as worker.ops.<kind>).
--
-- Additive. Rollback: an older master ignores the table and never sends the ops; to remove:
--   DELETE FROM worker_ops WHERE kind IN ('worker.uninstall', 'helper.manage');
--   DROP TABLE worker_removals;

CREATE TABLE worker_removals (
  id            uuid PRIMARY KEY,
  worker_id     text NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  purge         boolean NOT NULL,
  state         text NOT NULL CHECK (state IN ('requested', 'sent', 'done', 'refused', 'failed', 'cancelled')),
  op_id         uuid NULL,
  reason        text NULL CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,64}$'),
  detail        text NULL CHECK (detail IS NULL OR char_length(detail) <= 500),
  requested_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  requested_at  timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  finished_at   timestamptz NULL
);
CREATE UNIQUE INDEX worker_removals_one_open ON worker_removals (worker_id) WHERE state IN ('requested', 'sent');
CREATE INDEX worker_removals_recent ON worker_removals (worker_id, requested_at DESC);

-- Widening a closed CHECK list keeps every value an earlier migration allowed.
CREATE FUNCTION pg_temp.widen_check_0168(t text, c text, col text, extra text[]) RETURNS void
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

SELECT pg_temp.widen_check_0168('worker_ops', 'worker_ops_kind_check', 'kind', ARRAY['worker.uninstall', 'helper.manage']);
