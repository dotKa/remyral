-- p14-workflow-engine 14.0 (ADR-0055, docs/design/p14-workflow-engine.md §9): the general workflow engine's tables.
-- Additive only: new tables, nullable columns, widened CHECKs. Engine 1 keeps workflow_nodes / workflow_node_jobs /
-- workflow_edges / workflow_merge_requests unchanged and ignores everything here; engine-2 runs use the open states
-- queued / active / paused that engine-1 code never selects, so a code rollback freezes them instead of
-- misinterpreting them. Rollback of the schema: leave it (older code ignores the new tables and columns).

---------------------------------------------------------------------------------------------------- runs
ALTER TABLE workflow_runs
  ADD COLUMN engine smallint NOT NULL DEFAULT 1 CHECK (engine IN (1, 2)),
  ADD COLUMN parent_run_id uuid NULL REFERENCES workflow_runs (id),
  ADD COLUMN parent_node_run_id uuid NULL,
  ADD COLUMN rerun_of uuid NULL REFERENCES workflow_runs (id),
  ADD COLUMN rerun_from_node text NULL CHECK (rerun_from_node IS NULL OR length(rerun_from_node) <= 81),
  ADD COLUMN trigger_kind text NULL CHECK (trigger_kind IS NULL OR trigger_kind IN
    ('manual', 'schedule', 'webhook', 'github', 'workflow', 'chat', 'automation', 'subworkflow', 'rerun')),
  ADD COLUMN source_trust text NULL CHECK (source_trust IS NULL OR source_trust IN ('trusted', 'untrusted')),
  ADD COLUMN concurrency_key text NULL CHECK (concurrency_key IS NULL OR length(concurrency_key) <= 200),
  ADD COLUMN outputs jsonb NULL CHECK (outputs IS NULL OR jsonb_typeof(outputs) IN ('object', 'array', 'string',
                                                                                       'number', 'boolean', 'null')),
  ADD COLUMN paused_at timestamptz NULL,
  ADD COLUMN paused_by text NULL CHECK (paused_by IS NULL OR length(paused_by) <= 128);

-- Engine 1 states plus the engine-2 open states (queued: waiting for a concurrency slot; active; paused).
ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_state_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_state_check
  CHECK (state IN ('starting', 'running', 'awaiting_merge', 'succeeded', 'failed', 'cancelled',
                   'queued', 'active', 'paused'));
-- Engine 2 never uses engine-1 open states and vice versa.
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_engine_state_check
  CHECK ((engine = 1 AND state IN ('starting', 'running', 'awaiting_merge', 'succeeded', 'failed', 'cancelled'))
      OR (engine = 2 AND state IN ('queued', 'active', 'paused', 'succeeded', 'failed', 'cancelled')));
CREATE INDEX workflow_runs_engine2_open_idx ON workflow_runs (state, created_at)
  WHERE engine = 2 AND state IN ('queued', 'active', 'paused');

-- The identity of a run (now including its engine, lineage and trigger) never changes; finished runs are immutable.
CREATE OR REPLACE FUNCTION workflow_runs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workflow_runs rows cannot be deleted' USING ERRCODE = 'RA000';
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'workflow run % is finished and immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF (NEW.id, NEW.definition_id, NEW.project, NEW.inputs, NEW.repository, NEW.created_by, NEW.created_at,
      NEW.engine, NEW.parent_run_id, NEW.parent_node_run_id, NEW.rerun_of, NEW.rerun_from_node, NEW.trigger_kind,
      NEW.source_trust, NEW.concurrency_key)
     IS DISTINCT FROM
     (OLD.id, OLD.definition_id, OLD.project, OLD.inputs, OLD.repository, OLD.created_by, OLD.created_at,
      OLD.engine, OLD.parent_run_id, OLD.parent_node_run_id, OLD.rerun_of, OLD.rerun_from_node, OLD.trigger_kind,
      OLD.source_trust, OLD.concurrency_key) THEN
    RAISE EXCEPTION 'workflow run % identity columns are immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;

---------------------------------------------------------------------------------------------------- node runs
-- One row per (run, node, scope, attempt): the durable per-node-run state machine of engine 2 (§5.3). Transitions
-- are optimistic (`version`); timers are rows (`due_at`), not memory.
CREATE TABLE workflow_node_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES workflow_runs (id),
  node_id          text NOT NULL CHECK (node_id ~ '^[a-z][a-z0-9_-]{0,47}(\.[a-z][a-z0-9_-]{0,31})?$'),
  node_type        text NOT NULL CHECK (node_type ~ '^[a-z]+\.[A-Za-z]{1,40}$'),
  -- '' at top level, else the enclosing group iterations, e.g. 'each[3]/retry[1]'.
  scope            text NOT NULL DEFAULT '' CHECK (length(scope) <= 200),
  attempt          integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  state            text NOT NULL CHECK (state IN ('pending', 'ready', 'running', 'waiting', 'retry_wait', 'succeeded',
                                                  'failed', 'skipped', 'cancelled')),
  wait_kind        text NULL CHECK (wait_kind IS NULL OR wait_kind IN ('timer', 'webhook', 'approval', 'job',
                                                                       'child_run', 'ops_action', 'side_effect')),
  CHECK ((state = 'waiting') = (wait_kind IS NOT NULL)),
  due_at           timestamptz NULL,
  placement        text NOT NULL CHECK (placement IN ('master', 'integration', 'worker')),
  -- The port the value was emitted on (succeeded), or NULL.
  output_port      text NULL CHECK (output_port IS NULL OR output_port ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- What the node actually used (AI steps: role, resolved JobSpec, frozen upstream snapshot) — inline ≤ 16 KiB or
  -- {"$payload": sha256}; pruned to {"$pruned": true} after retention.
  input            jsonb NULL CHECK (input IS NULL OR jsonb_typeof(input) = 'object'),
  output           jsonb NULL,
  -- {code, message ≤ 1000} — failures and skip reasons (dead_path / upstream_failed).
  error            jsonb NULL CHECK (error IS NULL OR (jsonb_typeof(error) = 'object' AND error ? 'code')),
  -- Human-readable state note (waiting for approval, retry n/m after …).
  reason           text NULL CHECK (reason IS NULL OR length(reason) <= 1000),
  idempotency_key  text NOT NULL CHECK (idempotency_key ~ '^[a-f0-9]{64}$'),
  version          integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  gate_role        text NULL CHECK (gate_role IS NULL OR gate_role IN ('operator', 'admin', 'owner')),
  gate_decision    text NULL CHECK (gate_decision IS NULL OR gate_decision IN ('approved', 'denied')),
  gate_decided_by  text NULL CHECK (gate_decided_by IS NULL OR length(gate_decided_by) <= 128),
  gate_decided_at  timestamptz NULL,
  scheduled_at     timestamptz NULL,
  started_at       timestamptz NULL,
  ended_at         timestamptz NULL,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  UNIQUE (run_id, node_id, scope, attempt)
);
CREATE INDEX workflow_node_runs_due_idx ON workflow_node_runs (due_at)
  WHERE state IN ('waiting', 'retry_wait') AND due_at IS NOT NULL;
CREATE INDEX workflow_node_runs_run_idx ON workflow_node_runs (run_id, state);

ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_parent_node_run_fk
  FOREIGN KEY (parent_node_run_id) REFERENCES workflow_node_runs (id);

-- No DELETE; a terminal node run is immutable except that retention may prune its data.
CREATE FUNCTION workflow_node_runs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workflow_node_runs rows cannot be deleted' USING ERRCODE = 'RA000';
  END IF;
  IF (NEW.id, NEW.run_id, NEW.node_id, NEW.node_type, NEW.scope, NEW.attempt, NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.run_id, OLD.node_id, OLD.node_type, OLD.scope, OLD.attempt, OLD.idempotency_key, OLD.created_at) THEN
    RAISE EXCEPTION 'workflow node run % identity columns are immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'skipped', 'cancelled') THEN
    IF NEW.state IS DISTINCT FROM OLD.state OR NEW.output_port IS DISTINCT FROM OLD.output_port
       OR NEW.error IS DISTINCT FROM OLD.error OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
       OR (NEW.input IS DISTINCT FROM OLD.input AND NEW.input IS DISTINCT FROM '{"$pruned": true}'::jsonb)
       OR (NEW.output IS DISTINCT FROM OLD.output AND NEW.output IS DISTINCT FROM '{"$pruned": true}'::jsonb) THEN
      RAISE EXCEPTION 'workflow node run % is finished and immutable', OLD.id USING ERRCODE = 'RA000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_node_runs_guarded
  BEFORE UPDATE OR DELETE ON workflow_node_runs
  FOR EACH ROW EXECUTE FUNCTION workflow_node_runs_guard();

-- Every job of an engine-2 node run (AI or function), every attempt — what the dispatch admission reads.
CREATE TABLE workflow_node_run_jobs (
  node_run_id  uuid NOT NULL REFERENCES workflow_node_runs (id),
  job_id       uuid NOT NULL UNIQUE REFERENCES jobs (id),
  kind         text NOT NULL CHECK (kind IN ('ai', 'function')),
  created_at   timestamptz NOT NULL,
  PRIMARY KEY (node_run_id, job_id)
);
CREATE TRIGGER workflow_node_run_jobs_append_only
  BEFORE UPDATE OR DELETE ON workflow_node_run_jobs
  FOR EACH ROW EXECUTE FUNCTION workflow_history_reject_change();

-- Job ↔ workflow run membership across both engines (quotas, queue, automations, efficiency, integration read it).
CREATE VIEW workflow_job_links AS
  SELECT wj.job_id, wj.run_id, wj.node_id, 1::smallint AS engine FROM workflow_node_jobs wj
  UNION ALL
  SELECT l.job_id, nr.run_id, nr.node_id, 2::smallint AS engine
    FROM workflow_node_run_jobs l JOIN workflow_node_runs nr ON nr.id = l.node_run_id;

---------------------------------------------------------------------------------------------------- payloads
-- Values larger than the inline limit, stored once per run by hash; pruning nulls the content.
CREATE TABLE workflow_payloads (
  run_id      uuid NOT NULL REFERENCES workflow_runs (id),
  sha256      text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes  integer NOT NULL CHECK (size_bytes BETWEEN 0 AND 4194304),
  content     bytea NULL CHECK (content IS NULL OR length(content) <= 4194304),
  redacted    boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL,
  pruned_at   timestamptz NULL,
  CHECK ((content IS NULL) = (pruned_at IS NOT NULL)),
  PRIMARY KEY (run_id, sha256)
);

---------------------------------------------------------------------------------------------------- side effects
-- The outbox / fencing ledger of master integrations: one row per (node run, kind) — e.g. an integrator's merge
-- request and its deploy step — created in the transaction that moves the node run on; the integration is performed
-- exactly once from it and found again by `external_ref` / `idempotency_key` after a crash.
CREATE TABLE workflow_side_effects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_run_id      uuid NOT NULL REFERENCES workflow_node_runs (id),
  kind             text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{0,47}$'),
  idempotency_key  text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  external_ref     text NULL CHECK (external_ref IS NULL OR length(external_ref) <= 500),
  state            text NOT NULL CHECK (state IN ('pending', 'requested', 'succeeded', 'failed', 'refused',
                                                  'cancelled')),
  -- Non-secret metadata for the run view (branches of a merge request, action kind, …).
  detail           jsonb NULL CHECK (detail IS NULL OR jsonb_typeof(detail) = 'object'),
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  UNIQUE (node_run_id, kind)
);

---------------------------------------------------------------------------------------------------- waits
CREATE TABLE workflow_waits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_run_id      uuid NOT NULL UNIQUE REFERENCES workflow_node_runs (id),
  -- SHA-256 of the 256-bit single-use resume token (the token itself is never stored).
  token_hash       bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  mode             text NOT NULL CHECK (mode IN ('signed', 'token')),
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz NULL,
  consumed_digest  text NULL CHECK (consumed_digest IS NULL OR consumed_digest ~ '^[a-f0-9]{64}$'),
  created_at       timestamptz NOT NULL
);

---------------------------------------------------------------------------------------------------- triggers (K2)
ALTER TABLE automations
  ADD COLUMN workflow_trigger_node text NULL
    CHECK (workflow_trigger_node IS NULL OR workflow_trigger_node ~ '^[a-z][a-z0-9_-]{0,47}$'),
  ADD COLUMN source_workflow_project text NULL REFERENCES projects (id),
  ADD COLUMN source_workflow_name text NULL
    CHECK (source_workflow_name IS NULL OR source_workflow_name ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT automations_source_workflow_check
    CHECK ((source_workflow_project IS NULL) = (source_workflow_name IS NULL));

-- A chain trigger fires on another automation's runs (as before) or on a workflow's runs (`trigger.workflow`).
DO $$
DECLARE
  c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'automations'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%chain_source_id IS NOT NULL%'
     AND pg_get_constraintdef(oid) LIKE '%chain%';
  IF c IS NULL THEN
    RAISE EXCEPTION 'chain constraint of automations not found';
  END IF;
  EXECUTE format('ALTER TABLE automations DROP CONSTRAINT %I', c);
END;
$$;
ALTER TABLE automations ADD CONSTRAINT automations_chain_source_check
  CHECK ((trigger_kind = 'chain') = (chain_source_id IS NOT NULL OR source_workflow_name IS NOT NULL)
     AND NOT (chain_source_id IS NOT NULL AND source_workflow_name IS NOT NULL));

CREATE TABLE workflow_trigger_bindings (
  project          text NOT NULL REFERENCES projects (id),
  name             text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]{0,63}$'),
  trigger_node_id  text NOT NULL CHECK (trigger_node_id ~ '^[a-z][a-z0-9_-]{0,47}$'),
  automation_id    uuid NOT NULL UNIQUE REFERENCES automations (id),
  -- NULL: the latest version at fire time (default); else this version.
  pinned_version   integer NULL CHECK (pinned_version IS NULL OR pinned_version >= 1),
  enabled          boolean NOT NULL,
  updated_by       text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  updated_at       timestamptz NOT NULL,
  PRIMARY KEY (project, name, trigger_node_id)
);

---------------------------------------------------------------------------------------------------- HTTP egress (K1)
-- Owner decision K1: HTTP request nodes may call any public address by default (`open`); a project may turn its
-- allowlist on (`allowlist`: only `hosts`). LAN / private / link-local / loopback / metadata addresses are refused
-- in every mode (the worker checks every resolved address) and requests always leave from a worker.
CREATE TABLE workflow_egress (
  project     text PRIMARY KEY REFERENCES projects (id),
  mode        text NOT NULL DEFAULT 'open' CHECK (mode IN ('open', 'allowlist')),
  -- `host` or `host:port` (EgressHost shape, no IP literals of private ranges); the suggestion list in open mode.
  hosts       text[] NOT NULL DEFAULT '{}' CHECK (cardinality(hosts) <= 64),
  updated_by  text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  updated_at  timestamptz NOT NULL
);

---------------------------------------------------------------------------------------------------- vault (K1, K4)
-- `http-auth`: header / bearer / basic / query credentials of HTTP nodes; `smtp`: the SMTP password of e-mail nodes.
-- Both are bound to `allowed_hosts` (exact host[:port], ≤ 16): the worker attaches the value only for those hosts.
DO $$
DECLARE
  def text;
  kinds text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'vault_credentials_kind_check' AND conrelid = 'vault_credentials'::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint vault_credentials_kind_check not found';
  END IF;
  IF def ~ '\{' THEN
    kinds := string_to_array(substring(def from '\{([^}]*)\}'), ',');
  ELSE
    SELECT array_agg(DISTINCT m[1]) INTO kinds FROM regexp_matches(def, '''([a-z0-9-]+)''', 'g') AS m;
  END IF;
  IF coalesce(array_length(kinds, 1), 0) < 2 THEN
    RAISE EXCEPTION 'could not read the kinds of vault_credentials_kind_check';
  END IF;
  kinds := kinds || ARRAY['http-auth', 'smtp'];
  SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
  ALTER TABLE vault_credentials DROP CONSTRAINT vault_credentials_kind_check;
  EXECUTE format('ALTER TABLE vault_credentials ADD CONSTRAINT vault_credentials_kind_check CHECK (kind = ANY (%L::text[]))',
                 kinds);
END;
$$;
ALTER TABLE vault_credentials
  ADD COLUMN allowed_hosts text[] NULL CHECK (allowed_hosts IS NULL OR cardinality(allowed_hosts) BETWEEN 1 AND 16),
  ADD CONSTRAINT vault_credentials_bound_hosts_check
    CHECK (kind NOT IN ('http-auth', 'smtp') OR allowed_hosts IS NOT NULL);

---------------------------------------------------------------------------------------------------- project settings
ALTER TABLE projects
  ADD COLUMN workflow_data_retention_days integer NULL
    CHECK (workflow_data_retention_days IS NULL OR workflow_data_retention_days BETWEEN 1 AND 365),
  ADD COLUMN workflow_max_function_jobs integer NULL
    CHECK (workflow_max_function_jobs IS NULL OR workflow_max_function_jobs BETWEEN 1 AND 100);

---------------------------------------------------------------------------------------------------- notifications
-- workflow.notify (notify.users node), workflow.failed, workflow.waiting — appended to whatever the constraints allow
-- now (other migrations of the same release may add kinds too).
DO $$
DECLARE
  t text;
  def text;
  kinds text[];
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_preferences'] LOOP
    SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
     WHERE conname = t || '_kind_check' AND conrelid = t::regclass;
    IF def IS NULL THEN
      RAISE EXCEPTION 'constraint %_kind_check not found', t;
    END IF;
    IF def ~ '\{' THEN
      kinds := string_to_array(substring(def from '\{([^}]*)\}'), ',');
    ELSE
      SELECT array_agg(DISTINCT m[1]) INTO kinds FROM regexp_matches(def, '''([a-z0-9_.]+)''', 'g') AS m;
    END IF;
    IF coalesce(array_length(kinds, 1), 0) < 2 THEN
      RAISE EXCEPTION 'could not read the kinds of %_kind_check', t;
    END IF;
    kinds := kinds || ARRAY['workflow.notify', 'workflow.failed', 'workflow.waiting'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_kind_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, t || '_kind_check', kinds);
  END LOOP;
END;
$$;
