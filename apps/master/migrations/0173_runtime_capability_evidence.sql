-- p17-runtime-verify (docs/design/p17-runtime-verify.md): runtime capability verification from the panel.
--
--  * runtime_capability_evidence: one row per finished verification run ("Doğrula" on Makine → Runtime’lar) — the
--    tuple it proves (runtime, runtime version, adapter revision, OS, arch), the machine, worker version, auth mode,
--    sandbox profile, time, tokens, per-capability results (passed / failed / skipped + reason), the adapter's declared
--    table, and the evidence document with the worker's device-key signature (verified before the row is written; a
--    bad signature is audited and never stored). The id is the master's operation id (OPS_COMMAND commandId).
--    Evidence applies fleet-wide to exactly its tuple; another runtime version or adapter revision is a different tuple
--    (it "expires" by not matching).
--  * runtime_catalog_verifications: the owner's local mark that an unverified catalog runtime version passed its
--    verification on this installation (Ayarlar → Sürümler). Never changes the signed catalog (vendor routine).
--  * worker_runtimes.adapter_version / declared_capabilities: what a worker reports (CAPABILITIES runtime
--    `verification`) — needed to apply evidence to that machine. NULL: an older worker (no evidence applies).
--  * worker_ops.kind + 'runtime.capabilities.verify'.
--
-- Additive. Rollback: an older master ignores the tables and columns and never sends the op; to remove:
--   DELETE FROM worker_ops WHERE kind = 'runtime.capabilities.verify';
--   DROP TABLE runtime_catalog_verifications; DROP TABLE runtime_capability_evidence;
--   ALTER TABLE worker_runtimes DROP COLUMN adapter_version, DROP COLUMN declared_capabilities;

CREATE TABLE runtime_capability_evidence (
  id                uuid PRIMARY KEY,
  worker_id         text NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  runtime           text NOT NULL CHECK (runtime ~ '^[a-z][a-z0-9-]{0,31}$'),
  runtime_version   text NOT NULL CHECK (char_length(runtime_version) BETWEEN 1 AND 64),
  adapter_version   text NOT NULL CHECK (char_length(adapter_version) BETWEEN 1 AND 96),
  os                text NOT NULL CHECK (os IN ('darwin', 'linux', 'win32')),
  arch              text NOT NULL CHECK (arch IN ('x64', 'arm64')),
  worker_version    text NOT NULL CHECK (char_length(worker_version) <= 64),
  auth_mode         text NOT NULL CHECK (auth_mode IN ('secret-ref', 'local-login', 'none')),
  sandbox_profile   text NOT NULL,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz NOT NULL,
  duration_ms       bigint NOT NULL CHECK (duration_ms >= 0),
  input_tokens      bigint NOT NULL CHECK (input_tokens >= 0),
  output_tokens     bigint NOT NULL CHECK (output_tokens >= 0),
  cost_usd          numeric(12, 6) NULL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  stopped_by        text NULL CHECK (stopped_by IS NULL OR stopped_by IN ('time_budget', 'token_budget', 'cancelled', 'error')),
  passed            integer NOT NULL CHECK (passed >= 0),
  failed            integer NOT NULL CHECK (failed >= 0),
  results           jsonb NOT NULL CHECK (jsonb_typeof(results) = 'array'),
  declared          jsonb NOT NULL CHECK (jsonb_typeof(declared) = 'object'),
  -- The evidence exactly as signed and the device-key signature (re-verifiable later).
  evidence          jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  signature         text NOT NULL CHECK (signature ~ '^[A-Za-z0-9_-]{86}$'),
  requested_by      uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  received_at       timestamptz NOT NULL
);
CREATE INDEX runtime_capability_evidence_tuple
  ON runtime_capability_evidence (runtime, runtime_version, os, arch, adapter_version, finished_at DESC);
CREATE INDEX runtime_capability_evidence_worker
  ON runtime_capability_evidence (worker_id, runtime, finished_at DESC);

CREATE TABLE runtime_catalog_verifications (
  runtime       text NOT NULL CHECK (runtime ~ '^[a-z][a-z0-9-]{0,31}$'),
  version       text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 64),
  evidence_id   uuid NOT NULL REFERENCES runtime_capability_evidence (id) ON DELETE CASCADE,
  marked_by     uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  marked_at     timestamptz NOT NULL,
  PRIMARY KEY (runtime, version)
);

ALTER TABLE worker_runtimes
  ADD COLUMN adapter_version text NULL CHECK (adapter_version IS NULL OR char_length(adapter_version) BETWEEN 1 AND 96),
  ADD COLUMN declared_capabilities jsonb NULL
    CHECK (declared_capabilities IS NULL OR jsonb_typeof(declared_capabilities) = 'object');

-- Widening a closed CHECK list keeps every value an earlier migration allowed.
CREATE FUNCTION pg_temp.widen_check_0173(t text, c text, col text, extra text[]) RETURNS void
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

SELECT pg_temp.widen_check_0173('worker_ops', 'worker_ops_kind_check', 'kind', ARRAY['runtime.capabilities.verify']);
