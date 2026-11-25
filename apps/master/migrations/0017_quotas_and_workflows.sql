-- p4-quotas (acceptance A-ORCH-2; ADR-0014 §5; docs/design/p4-quotas.md): quota policy versions, provider
-- pauses, project holds (kill switch) and the enforcement log. Rows are written only through
-- src/quotas (QuotaStore); triggers are defence in depth (SQLSTATE RA000). Additive only.

-- Quota policy: every save is a complete new version (append-only). No row = the built-in defaults
-- (DEFAULT_QUOTA_POLICY in @remana/scheduler: no limits, warn on incomplete dollar figures).
CREATE TABLE quota_policies (
  version     integer PRIMARY KEY CHECK (version >= 1),
  policy      jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  note        text NULL CHECK (length(note) <= 500),
  created_by  text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  created_at  timestamptz NOT NULL
);

CREATE FUNCTION quota_policies_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'quota_policies is append-only (% rejected)', TG_OP USING ERRCODE = 'RA000';
  END IF;
  SELECT max(version) INTO latest FROM quota_policies;
  IF NEW.version <> COALESCE(latest, 0) + 1 THEN
    RAISE EXCEPTION 'quota policy version must be %', COALESCE(latest, 0) + 1 USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quota_policies_append_only
  BEFORE INSERT OR UPDATE OR DELETE ON quota_policies
  FOR EACH ROW EXECUTE FUNCTION quota_policies_guard();
CREATE TRIGGER quota_policies_no_truncate
  BEFORE TRUNCATE ON quota_policies
  FOR EACH STATEMENT EXECUTE FUNCTION quota_policies_guard();

-- Provider pauses (`provider_usage_limit`): scheduling of one runtime on one worker, or of every member
-- of a provider account, stops until `resume_at` (or an admin resumes it early).
CREATE TABLE quota_pauses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope              text NOT NULL CHECK (scope IN ('worker_runtime', 'account')),
  worker_id          text NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  runtime            text NOT NULL CHECK (runtime ~ '^[a-z0-9_-]{1,32}$'),
  account_id         text NULL CHECK (account_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  reason             text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  -- The attempt whose JOB_RESULT reported the limit: one pause per report (idempotent scan).
  source_attempt_id  uuid NULL UNIQUE,
  source_job_id      uuid NULL,
  paused_at          timestamptz NOT NULL,
  resume_at          timestamptz NOT NULL CHECK (resume_at > paused_at),
  resumed_at         timestamptz NULL,
  resumed_by         text NULL CHECK (length(resumed_by) <= 128),
  CHECK ((scope = 'worker_runtime') = (worker_id IS NOT NULL)),
  CHECK ((scope = 'account') = (account_id IS NOT NULL))
);
CREATE INDEX quota_pauses_active_idx ON quota_pauses (resume_at) WHERE resumed_at IS NULL;

CREATE FUNCTION quota_pauses_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quota_pauses rows cannot be deleted' USING ERRCODE = 'RA000';
  END IF;
  -- Only an early resume may change a pause, once.
  IF OLD.resumed_at IS NOT NULL OR NEW.resumed_at IS NULL
     OR (NEW.id, NEW.scope, NEW.worker_id, NEW.runtime, NEW.account_id, NEW.reason, NEW.source_attempt_id,
         NEW.paused_at, NEW.resume_at)
        IS DISTINCT FROM
        (OLD.id, OLD.scope, OLD.worker_id, OLD.runtime, OLD.account_id, OLD.reason, OLD.source_attempt_id,
         OLD.paused_at, OLD.resume_at) THEN
    RAISE EXCEPTION 'pause % can only be resumed once', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quota_pauses_guarded
  BEFORE UPDATE OR DELETE ON quota_pauses
  FOR EACH ROW EXECUTE FUNCTION quota_pauses_guard();

-- Kill switch hold: while a row exists no job of the project is dispatched (released by an admin; the
-- audit log keeps the history).
CREATE TABLE quota_project_holds (
  project   text PRIMARY KEY REFERENCES projects (id),
  reason    text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  held_by   text NOT NULL CHECK (length(held_by) BETWEEN 1 AND 128),
  held_at   timestamptz NOT NULL
);

-- Enforcement log shown on Usage → Enforcement (append-only). `dedupe_key` makes each decision appear once
-- (e.g. one `job_stopped` per job, one `incomplete_cost` warning per budget window).
CREATE TABLE quota_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('dispatch_held', 'job_stopped', 'incomplete_cost',
                                            'provider_paused', 'provider_resumed', 'kill_switch',
                                            'hold_released')),
  project     text NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  job_id      uuid NULL,
  worker_id   text NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  code        text NOT NULL CHECK (code ~ '^[a-z_]{1,64}$'),
  message     text NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  dedupe_key  text NULL UNIQUE CHECK (length(dedupe_key) <= 300),
  created_at  timestamptz NOT NULL
);
CREATE INDEX quota_events_time_idx ON quota_events (created_at DESC, id DESC);
CREATE INDEX quota_events_project_idx ON quota_events (project, created_at DESC);

CREATE FUNCTION quota_events_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'quota_events is append-only (% rejected)', TG_OP USING ERRCODE = 'RA000';
END;
$$;
CREATE TRIGGER quota_events_append_only
  BEFORE UPDATE OR DELETE ON quota_events
  FOR EACH ROW EXECUTE FUNCTION quota_events_reject_change();
CREATE TRIGGER quota_events_no_truncate
  BEFORE TRUNCATE ON quota_events
  FOR EACH STATEMENT EXECUTE FUNCTION quota_events_reject_change();

-- The provider-limit scan reads JOB_RESULTs with this error code.
CREATE INDEX job_runs_error_code_idx ON job_runs ((result -> 'error' ->> 'code'))
  WHERE result_outcome = 'failed';

---------------------------------------------------------------------------------------------------
-- p4-dag (acceptance A-ORCH-1; ADR-0010; docs/design/p4-dag.md): workflow definitions (versioned, append-only),
-- runs, nodes (one current job each, all jobs in workflow_node_jobs), run edges (static + planner sub-DAGs)
-- and integrator merge requests. Rows are written only through src/workflows (WorkflowService).

CREATE TABLE workflow_definitions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project          text NOT NULL REFERENCES projects (id),
  name             text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]{0,63}$'),
  version          integer NOT NULL CHECK (version >= 1),
  definition       jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  definition_hash  text NOT NULL CHECK (definition_hash ~ '^[a-f0-9]{64}$'),
  created_by       text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  created_at       timestamptz NOT NULL,
  UNIQUE (project, name, version)
);

CREATE FUNCTION workflow_definitions_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workflow_definitions is append-only (% rejected)', TG_OP USING ERRCODE = 'RA000';
END;
$$;
CREATE TRIGGER workflow_definitions_append_only
  BEFORE UPDATE OR DELETE ON workflow_definitions
  FOR EACH ROW EXECUTE FUNCTION workflow_definitions_reject_change();
CREATE TRIGGER workflow_definitions_no_truncate
  BEFORE TRUNCATE ON workflow_definitions
  FOR EACH STATEMENT EXECUTE FUNCTION workflow_definitions_reject_change();

CREATE TABLE workflow_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id  uuid NOT NULL REFERENCES workflow_definitions (id),
  project        text NOT NULL REFERENCES projects (id),
  name           text NOT NULL,
  version        integer NOT NULL,
  state          text NOT NULL CHECK (state IN ('starting', 'running', 'awaiting_merge', 'succeeded', 'failed',
                                                'cancelled')),
  inputs         jsonb NOT NULL CHECK (jsonb_typeof(inputs) = 'object'),
  repository     jsonb NOT NULL CHECK (jsonb_typeof(repository) = 'object'),
  created_by     text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  ended_at       timestamptz NULL,
  reason         text NULL CHECK (length(reason) <= 1000)
);
CREATE INDEX workflow_runs_open_idx ON workflow_runs (created_at) WHERE state IN ('starting', 'running', 'awaiting_merge');
CREATE INDEX workflow_runs_project_idx ON workflow_runs (project, created_at DESC);

CREATE FUNCTION workflow_runs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workflow_runs rows cannot be deleted' USING ERRCODE = 'RA000';
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'workflow run % is finished and immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF (NEW.id, NEW.definition_id, NEW.project, NEW.inputs, NEW.repository, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.definition_id, OLD.project, OLD.inputs, OLD.repository, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'workflow run % identity columns are immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_runs_guarded
  BEFORE UPDATE OR DELETE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION workflow_runs_guard();

CREATE TABLE workflow_nodes (
  run_id             uuid NOT NULL REFERENCES workflow_runs (id),
  node_id            text NOT NULL CHECK (node_id ~ '^[a-z][a-z0-9_-]{0,47}(\.[a-z][a-z0-9_-]{0,31})?$'),
  role               text NOT NULL CHECK (role IN ('planner', 'executor', 'verifier', 'reviewer', 'integrator')),
  def                jsonb NOT NULL CHECK (jsonb_typeof(def) = 'object'),
  -- The JobSpec every job of this node is created from (retries reuse it).
  job_spec           jsonb NOT NULL CHECK (jsonb_typeof(job_spec) = 'object'),
  state              text NOT NULL CHECK (state IN ('pending', 'awaiting_approval', 'queued', 'succeeded', 'failed',
                                                    'skipped', 'cancelled', 'awaiting_merge')),
  job_id             uuid NULL REFERENCES jobs (id),
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- {summary, branch, commits, jobId, attemptId}: redacted, clipped; data for downstream nodes.
  outputs            jsonb NULL CHECK (outputs IS NULL OR jsonb_typeof(outputs) = 'object'),
  -- Upstream values frozen when the node was released (provenance of what the agent saw, ADR-0010 §4).
  upstream_snapshot  jsonb NULL CHECK (upstream_snapshot IS NULL OR jsonb_typeof(upstream_snapshot) = 'array'),
  gate_role          text NULL CHECK (gate_role IN ('operator', 'admin', 'owner')),
  gate_decision      text NULL CHECK (gate_decision IN ('approved', 'denied')),
  gate_decided_by    text NULL CHECK (length(gate_decided_by) <= 128),
  gate_decided_at    timestamptz NULL,
  parent_node        text NULL,
  reason             text NULL CHECK (length(reason) <= 1000),
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  PRIMARY KEY (run_id, node_id)
);
CREATE INDEX workflow_nodes_job_idx ON workflow_nodes (job_id);

CREATE TABLE workflow_node_jobs (
  job_id      uuid PRIMARY KEY REFERENCES jobs (id),
  run_id      uuid NOT NULL,
  node_id     text NOT NULL,
  attempt     integer NOT NULL CHECK (attempt >= 1),
  created_at  timestamptz NOT NULL,
  UNIQUE (run_id, node_id, attempt),
  FOREIGN KEY (run_id, node_id) REFERENCES workflow_nodes (run_id, node_id)
);

CREATE TABLE workflow_edges (
  run_id     uuid NOT NULL,
  from_node  text NOT NULL,
  to_node    text NOT NULL,
  PRIMARY KEY (run_id, from_node, to_node),
  CHECK (from_node <> to_node),
  FOREIGN KEY (run_id, from_node) REFERENCES workflow_nodes (run_id, node_id),
  FOREIGN KEY (run_id, to_node) REFERENCES workflow_nodes (run_id, node_id)
);

CREATE TABLE workflow_merge_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES workflow_runs (id),
  node_id         text NOT NULL,
  job_id          uuid NULL REFERENCES jobs (id),
  project         text NOT NULL,
  repository_url  text NOT NULL CHECK (length(repository_url) <= 2048),
  base_ref        text NOT NULL CHECK (length(base_ref) <= 255),
  branches        jsonb NOT NULL CHECK (jsonb_typeof(branches) = 'array'),
  status          text NOT NULL CHECK (status IN ('pending', 'merged', 'refused')),
  external_ref    text NULL CHECK (length(external_ref) <= 500),
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  FOREIGN KEY (run_id, node_id) REFERENCES workflow_nodes (run_id, node_id)
);

-- Edges and job membership are immutable history (append-only).
CREATE FUNCTION workflow_history_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'RA000';
END;
$$;
CREATE TRIGGER workflow_edges_append_only
  BEFORE UPDATE OR DELETE ON workflow_edges
  FOR EACH ROW EXECUTE FUNCTION workflow_history_reject_change();
CREATE TRIGGER workflow_node_jobs_append_only
  BEFORE UPDATE OR DELETE ON workflow_node_jobs
  FOR EACH ROW EXECUTE FUNCTION workflow_history_reject_change();
