-- p19-install-scripts (ADR-0068, docs/design/p19-install-scripts.md): npm packages whose install script an admin
-- reviewed and approved, platform-wide, for exactly one version and registry tarball (`dist.integrity`). An
-- `mcp.install` carries the active approvals to workers with `mcp-install-scripts-v1`; such a worker accepts a lockfile
-- entry with `hasInstallScript` only when name, version and integrity match, and runs only those scripts.
--
--  * npm_install_script_approvals  one row per approval (a revoked one keeps its row; approving again adds a new one).
--  * chat_drafts.kind              + install_script_approval (the assistant's draft_install_script_approval card).
--
-- Additive. Rollback: an older master never reads the table (drop it); to restore the chat_drafts check, delete the
-- `install_script_approval` drafts first.

CREATE TABLE npm_install_script_approvals (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 214),
  version     text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 64),
  integrity   text NOT NULL CHECK (integrity ~ '^sha512-[A-Za-z0-9+/]{86}==$'),
  -- What the reviewer saw (registry metadata, the scripts' text, provenance; bounded by the service).
  evaluation  jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason      text CHECK (reason IS NULL OR char_length(reason) <= 500),
  via         text NOT NULL CHECK (via IN ('console', 'chat')),
  approved_by uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_at timestamptz NOT NULL,
  revoked_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  revoked_at  timestamptz
);
-- One active approval per exact package tarball.
CREATE UNIQUE INDEX npm_install_script_approvals_active
  ON npm_install_script_approvals (name, version, integrity) WHERE revoked_at IS NULL;
CREATE INDEX npm_install_script_approvals_recent ON npm_install_script_approvals (approved_at DESC);

-- Widening a closed CHECK list keeps every value an earlier migration allowed.
CREATE FUNCTION pg_temp.widen_check_0195(t text, c text, col text, extra text[]) RETURNS void
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

SELECT pg_temp.widen_check_0195('chat_drafts', 'chat_drafts_kind_check', 'kind', ARRAY['install_script_approval']);
