-- p15-usage-refresh (docs/design/p15-usage-refresh.md): usage readings per provider account, on-demand refresh.
-- Additive only (rollback: leave the columns and the op kind unused). Migration number 0133 (given in the brief);
-- renumber at merge if needed.
--
-- 1. runtime_usage_snapshots.identity_key / identity_hint: which provider account (Claude / ChatGPT) a subscription
--    login is — a hashed key computed on the worker and a masked e-mail. The same key on several machines is one
--    account: the newest reading wins, every machine knows its limit.
-- 2. worker_ops.kind + 'usage.refresh' (remote op: read the usage windows now).

ALTER TABLE runtime_usage_snapshots
  ADD COLUMN identity_key  text NULL CHECK (identity_key IS NULL OR identity_key ~ '^[a-f0-9]{32}$'),
  ADD COLUMN identity_hint text NULL CHECK (identity_hint IS NULL OR (length(identity_hint) BETWEEN 1 AND 64
                                                                     AND identity_hint !~ '[[:cntrl:]]'));

CREATE INDEX runtime_usage_snapshots_identity ON runtime_usage_snapshots (runtime, identity_key)
  WHERE identity_key IS NOT NULL;

CREATE FUNCTION pg_temp.widen_check_0133(t text, c text, col text, extra text[]) RETURNS void
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

SELECT pg_temp.widen_check_0133('worker_ops', 'worker_ops_kind_check', 'kind', ARRAY['usage.refresh']);
