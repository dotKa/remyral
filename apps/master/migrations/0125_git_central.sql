-- p15-git-central (docs/design/p15-git-central.md): central git for every machine. Additive only (rollback: leave
-- the columns / values / table unused). Migration number 0125 (given in the brief); renumber at merge if needed.
--
-- 1. workers.git_readiness: CAPABILITIES.gitReadiness (git present / version, the worker account's git setup problems
--    — counted and classified, never a secret value), the machine page's Git card.
-- 2. worker_ops.kind + 'git.fix' (remote op: safe fixes of the worker account's git setup).
-- 3. vault_credentials.kind + 'git-ssh-key', 'git-https-token' (project repository credentials, sealed to workers).
-- 4. project_repo_credentials: which vault credential a project's non-GitHub / SSH repository uses (a reference;
--    the master never sees the value).

ALTER TABLE workers
  ADD COLUMN git_readiness jsonb NULL,
  ADD COLUMN git_readiness_at timestamptz NULL;

CREATE FUNCTION pg_temp.widen_check_0125(t text, c text, col text, extra text[]) RETURNS void
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

SELECT pg_temp.widen_check_0125('worker_ops', 'worker_ops_kind_check', 'kind', ARRAY['git.fix']);
SELECT pg_temp.widen_check_0125('vault_credentials', 'vault_credentials_kind_check', 'kind',
                                ARRAY['git-ssh-key', 'git-https-token']);

CREATE TABLE project_repo_credentials (
  project       text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('ssh-key', 'https-token')),
  -- The vault credential (sealed in the browser to the chosen workers); its kind must match (checked by the API).
  credential_id text NOT NULL REFERENCES vault_credentials (id) ON DELETE RESTRICT,
  -- https-token: the username sent with the token.
  username      text NULL CHECK (username IS NULL OR username ~ '^[A-Za-z0-9._@+-]{1,64}$'),
  -- ssh-key: pinned known_hosts lines (validated by the API; required for ssh-key).
  known_hosts   text NULL CHECK (known_hosts IS NULL OR length(known_hosts) <= 16384),
  -- What the credential can do at the host, as the admin declares it: untrusted-source jobs get only `read` ones.
  access        text NOT NULL DEFAULT 'write' CHECK (access IN ('read', 'write')),
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at    timestamptz NOT NULL,
  updated_by    uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  CHECK (kind <> 'ssh-key' OR known_hosts IS NOT NULL),
  CHECK (kind <> 'https-token' OR known_hosts IS NULL)
);
