-- p14-mcp-core (ADR-0054 decision 7, docs/design/p14-mcp-skills.md §2, P3): external MCP servers (remote http / sse)
-- for jobs. The catalog tables came with 0102; this migration only widens the CHECK lists P3 writes and adds three
-- columns. Additive only: older code ignores the new values and columns (rollback: leave them unused).
-- Migration number 0107: renumber at merge if a parallel change took it.
--
--  * approval_requests.action      + tool.mcp      (an `ask` tool of an external MCP server; admin approves)
--  * worker_ops.kind               + mcp.probe     (tool discovery on a worker; the master never connects)
--  * job_events.kind               + mcp_call      (metadata of one MCP tool call in the job timeline)
--  * notifications / preferences   + mcp.project_enabled (owners, critical: a project's MCP switch was turned on)
--  * mcp_server_tools.read_only_hint   the server's own `readOnlyHint` annotation (untrusted; only a suggestion)
--  * job_mcp_sets.skipped          why a job got no MCP although servers were assigned (switch off, untrusted source)
--  * job_mcp_sets.egress_hosts     the hosts the job's attempts may reach for its MCP servers (shown on the job page)
--  * job_mcp_pins.rules            the tool policy snapshot of the first issue (retries keep exactly these rules)

CREATE FUNCTION pg_temp.widen_check(t text, c text, col text, extra text[]) RETURNS void
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

SELECT pg_temp.widen_check('approval_requests', 'approval_requests_action_check', 'action', ARRAY['tool.mcp']);
SELECT pg_temp.widen_check('worker_ops', 'worker_ops_kind_check', 'kind', ARRAY['mcp.probe']);
SELECT pg_temp.widen_check('job_events', 'job_events_kind_check', 'kind', ARRAY['mcp_call']);
SELECT pg_temp.widen_check('notifications', 'notifications_kind_check', 'kind', ARRAY['mcp.project_enabled']);
SELECT pg_temp.widen_check('notification_preferences', 'notification_preferences_kind_check', 'kind',
                           ARRAY['mcp.project_enabled']);

ALTER TABLE mcp_server_tools ADD COLUMN read_only_hint boolean NULL;

ALTER TABLE job_mcp_sets
  ADD COLUMN skipped text NULL CHECK (skipped IS NULL OR skipped ~ '^[a-z_]{1,64}$'),
  ADD COLUMN egress_hosts text[] NOT NULL DEFAULT '{}' CHECK (cardinality(egress_hosts) <= 32);

ALTER TABLE job_mcp_pins
  ADD COLUMN rules jsonb NULL CHECK (rules IS NULL OR (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) <= 64));

CREATE INDEX job_mcp_calls_job_idx ON job_mcp_calls (job_id, at);
CREATE INDEX worker_ops_mcp_probe_idx ON worker_ops ((params ->> 'serverId'), requested_at DESC)
  WHERE kind = 'mcp.probe';
