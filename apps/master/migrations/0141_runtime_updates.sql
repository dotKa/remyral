-- p16-runtime-updates (docs/design/p16-runtime-updates.md): runtime versions newer than the worker release's pin,
-- installed as "unverified" through the owner's security policy (fleet.unverifiedRuntimeUpdates, on by default), and
-- the automatic verification of such versions on a canary machine. Additive only.
--
--  * runtime_candidates: one row per (runtime, runtime version) the master resolved from the npm registry — the
--    release's own package at that exact version and the registry's sha512 of its tarball; the dependency lock the
--    first machine resolved (shared with every later machine); the verification state.
--  * runtime_verifications: one row per verification run (machine, checks, outcome).
--  * worker_runtimes.unverified_update: CAPABILITIES says the version is an owner-approved install outside the pins.
--  * worker_ops.kind + 'runtime.verify'; chat_drafts.kind + 'runtime_update' (the assistant's draft_runtime_update).
--
-- Rollback: an older master ignores the tables and the column; to remove:
--   DELETE FROM chat_drafts WHERE kind = 'runtime_update';
--   DROP TABLE runtime_verifications; DROP TABLE runtime_candidates;
--   ALTER TABLE worker_runtimes DROP COLUMN unverified_update;
-- Migration number 0141 (0140_workflow_quality is the one before it on main).

CREATE TABLE runtime_candidates (
  runtime          text NOT NULL CHECK (runtime IN ('claude-code', 'codex', 'pi', 'opencode')),
  -- The version the runtime itself reports (what the probe compares with the pin).
  version          text NOT NULL CHECK (version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}([-+][0-9A-Za-z.-]{1,32})?$'),
  package          text NOT NULL CHECK (char_length(package) BETWEEN 1 AND 214),
  package_version  text NOT NULL CHECK (char_length(package_version) BETWEEN 1 AND 64),
  integrity        text NOT NULL CHECK (integrity ~ '^sha512-[A-Za-z0-9+/]{86}==$'),
  resolved_at      timestamptz NOT NULL,
  -- The npm lockfile v3 of exactly this release (gzip + base64, sha256 of the raw bytes), from the first machine.
  lock_gz          text NULL,
  lock_sha256      text NULL CHECK (lock_sha256 IS NULL OR lock_sha256 ~ '^[a-f0-9]{64}$'),
  lock_bytes       integer NULL CHECK (lock_bytes IS NULL OR lock_bytes > 0),
  lock_worker_id   text NULL,
  lock_at          timestamptz NULL,
  -- none: never run; running; passed: every required automatable check passed (a "verified candidate", still
  -- unverified in capability terms until it becomes the release pin); failed: a required check failed.
  verify_state     text NOT NULL DEFAULT 'none' CHECK (verify_state IN ('none', 'running', 'passed', 'failed')),
  verified_at      timestamptz NULL,
  PRIMARY KEY (runtime, version),
  CHECK ((lock_gz IS NULL) = (lock_sha256 IS NULL))
);

CREATE TABLE runtime_verifications (
  id           uuid PRIMARY KEY,
  runtime      text NOT NULL,
  version      text NOT NULL,
  worker_id    text NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  op_id        uuid NULL,
  os           text NULL,
  arch         text NULL,
  trigger      text NOT NULL CHECK (trigger IN ('schedule', 'feed', 'manual')),
  state        text NOT NULL CHECK (state IN ('running', 'passed', 'failed', 'error')),
  checks       jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason       text NULL CHECK (reason IS NULL OR char_length(reason) <= 64),
  detail       text NULL CHECK (detail IS NULL OR char_length(detail) <= 500),
  requested_by uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz NULL,
  FOREIGN KEY (runtime, version) REFERENCES runtime_candidates (runtime, version) ON DELETE CASCADE
);
CREATE INDEX runtime_verifications_candidate ON runtime_verifications (runtime, version, started_at DESC);

ALTER TABLE worker_runtimes ADD COLUMN unverified_update boolean NOT NULL DEFAULT false;

CREATE FUNCTION pg_temp.widen_check_0141(t text, c text, col text, extra text[]) RETURNS void
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

SELECT pg_temp.widen_check_0141('worker_ops', 'worker_ops_kind_check', 'kind', ARRAY['runtime.verify']);
SELECT pg_temp.widen_check_0141('chat_drafts', 'chat_drafts_kind_check', 'kind', ARRAY['runtime_update']);
