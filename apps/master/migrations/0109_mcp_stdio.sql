-- p14-mcp-stdio (ADR-0054 P4, docs/design/p14-mcp-skills.md §2.7, §14): local (stdio) MCP server packages from npm and
-- PyPI, installed through the fleet-tools pipeline (canary first, the canary's lockfile captured, every other machine
-- installs exactly that lock). The catalog tables `mcp_lockfiles` and `mcp_worker_installs` came with 0102; this
-- migration widens the CHECK lists P4 writes and adds a few install columns. Additive only: older code ignores the new
-- values and columns (rollback: leave them unused). Migration number 0109: renumber at merge if a parallel change
-- took it.
--
--  * fleet_tool_actions.kind  + mcp.install, mcp.remove   (bulk install / removal of one server version)
--  * worker_ops.kind          + mcp.install, mcp.remove   (the per-machine remote operations)
--  * mcp_worker_installs      + lock_sha256, files, bytes, op_id (what the machine reported; the op that did it)

CREATE FUNCTION pg_temp.widen_check_0109(t text, c text, col text, extra text[]) RETURNS void
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

SELECT pg_temp.widen_check_0109('fleet_tool_actions', 'fleet_tool_actions_kind_check', 'kind',
                           ARRAY['mcp.install', 'mcp.remove']);
SELECT pg_temp.widen_check_0109('worker_ops', 'worker_ops_kind_check', 'kind', ARRAY['mcp.install', 'mcp.remove']);

ALTER TABLE mcp_worker_installs
  ADD COLUMN lock_sha256 text NULL CHECK (lock_sha256 IS NULL OR lock_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN files integer NULL CHECK (files IS NULL OR files >= 0),
  ADD COLUMN bytes bigint NULL CHECK (bytes IS NULL OR bytes >= 0),
  ADD COLUMN op_id uuid NULL;

CREATE INDEX mcp_worker_installs_server_idx ON mcp_worker_installs (server_id, version, state);
CREATE INDEX fleet_tool_actions_mcp_idx ON fleet_tool_actions (item, created_at DESC) WHERE item LIKE 'mcp:%';
