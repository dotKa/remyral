-- p14-workflow-engine 14.4 (ADR-0055 addendum 14.4, docs/design/p14-workflow-engine.md §20): workflow operations —
-- pause / resume, re-run from a node, concurrency queues, run timeout from activation, error workflows, data retention.
-- Additive only (nullable / defaulted columns, one new table, widened CHECKs, guards that accept exactly the new
-- changes). Older code ignores the new columns and the table; rollback of the schema: leave it.

---------------------------------------------------------------------------------------------------- runs
ALTER TABLE workflow_runs
  -- When a run left the concurrency queue (or started): the run timeout counts from here.
  ADD COLUMN activated_at timestamptz NULL,
  -- Time spent paused so far (excluded from the run timeout; timeouts of waiting nodes are shifted on resume).
  ADD COLUMN paused_ms bigint NOT NULL DEFAULT 0 CHECK (paused_ms >= 0),
  -- The failed run this run is the error workflow of (at most one error run per failed run).
  ADD COLUMN error_of uuid NULL REFERENCES workflow_runs (id),
  -- Retention removed the run's node data (values became {"$pruned": true}).
  ADD COLUMN data_pruned_at timestamptz NULL;
CREATE UNIQUE INDEX workflow_runs_error_of_idx ON workflow_runs (error_of) WHERE error_of IS NOT NULL;
-- Concurrency groups: open runs of a workflow (and key), queued runs in order.
CREATE INDEX workflow_runs_concurrency_idx ON workflow_runs (project, name, concurrency_key, created_at)
  WHERE engine = 2 AND state IN ('queued', 'active', 'paused');
-- Retention scan and failure streaks: finished engine-2 runs by end time.
CREATE INDEX workflow_runs_engine2_ended_idx ON workflow_runs (ended_at)
  WHERE engine = 2 AND data_pruned_at IS NULL AND ended_at IS NOT NULL;
CREATE INDEX workflow_runs_engine2_streak_idx ON workflow_runs (project, name, ended_at DESC)
  WHERE engine = 2 AND parent_run_id IS NULL AND ended_at IS NOT NULL;

-- trigger_kind: + 'error' (a run started as another run's error workflow). 'rerun' already exists (0103).
DO $$
DECLARE
  c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'workflow_runs'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%trigger_kind%' AND pg_get_constraintdef(oid) LIKE '%subworkflow%';
  IF c IS NULL THEN
    RAISE EXCEPTION 'trigger_kind constraint of workflow_runs not found';
  END IF;
  EXECUTE format('ALTER TABLE workflow_runs DROP CONSTRAINT %I', c);
END;
$$;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_trigger_kind_check
  CHECK (trigger_kind IS NULL OR trigger_kind IN
    ('manual', 'schedule', 'webhook', 'github', 'workflow', 'chat', 'automation', 'subworkflow', 'rerun', 'error'));

-- Identity (now including error_of) never changes. A finished run is immutable except retention: data_pruned_at is set
-- once, and trigger_data / outputs may only become {"$pruned": true} in that same update.
CREATE OR REPLACE FUNCTION workflow_runs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workflow_runs rows cannot be deleted' USING ERRCODE = 'RA000';
  END IF;
  IF (NEW.id, NEW.definition_id, NEW.project, NEW.inputs, NEW.repository, NEW.created_by, NEW.created_at,
      NEW.engine, NEW.parent_run_id, NEW.parent_node_run_id, NEW.rerun_of, NEW.rerun_from_node, NEW.trigger_kind,
      NEW.source_trust, NEW.concurrency_key, NEW.trigger_node, NEW.error_of)
     IS DISTINCT FROM
     (OLD.id, OLD.definition_id, OLD.project, OLD.inputs, OLD.repository, OLD.created_by, OLD.created_at,
      OLD.engine, OLD.parent_run_id, OLD.parent_node_run_id, OLD.rerun_of, OLD.rerun_from_node, OLD.trigger_kind,
      OLD.source_trust, OLD.concurrency_key, OLD.trigger_node, OLD.error_of) THEN
    RAISE EXCEPTION 'workflow run % identity columns are immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'cancelled') THEN
    IF OLD.data_pruned_at IS NULL AND NEW.data_pruned_at IS NOT NULL
       AND (NEW.trigger_data IS NOT DISTINCT FROM OLD.trigger_data
            OR NEW.trigger_data IS NOT DISTINCT FROM '{"$pruned": true}'::jsonb)
       AND (NEW.outputs IS NOT DISTINCT FROM OLD.outputs
            OR NEW.outputs IS NOT DISTINCT FROM '{"$pruned": true}'::jsonb)
       AND (NEW.state, NEW.reason, NEW.ended_at, NEW.version, NEW.name, NEW.priority, NEW.activated_at,
            NEW.paused_ms, NEW.paused_at, NEW.paused_by)
           IS NOT DISTINCT FROM
           (OLD.state, OLD.reason, OLD.ended_at, OLD.version, OLD.name, OLD.priority, OLD.activated_at,
            OLD.paused_ms, OLD.paused_at, OLD.paused_by) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'workflow run % is finished and immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF OLD.trigger_data IS NOT NULL AND NEW.trigger_data IS DISTINCT FROM OLD.trigger_data THEN
    RAISE EXCEPTION 'workflow run % trigger data is immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;

---------------------------------------------------------------------------------------------------- node runs
-- A re-run's node runs taken over from the source run (finished, never executed again).
ALTER TABLE workflow_node_runs
  ADD COLUMN copied_from uuid NULL REFERENCES workflow_node_runs (id);

-- Retention may replace a terminal node run's input / output by an object carrying "$pruned": true (AI steps keep
-- their role, placement, job id and planner expansion so the run view stays drawable); copied_from is identity.
CREATE OR REPLACE FUNCTION workflow_node_runs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workflow_node_runs rows cannot be deleted' USING ERRCODE = 'RA000';
  END IF;
  IF (NEW.id, NEW.run_id, NEW.node_id, NEW.node_type, NEW.scope, NEW.attempt, NEW.idempotency_key, NEW.created_at,
      NEW.copied_from)
     IS DISTINCT FROM
     (OLD.id, OLD.run_id, OLD.node_id, OLD.node_type, OLD.scope, OLD.attempt, OLD.idempotency_key, OLD.created_at,
      OLD.copied_from) THEN
    RAISE EXCEPTION 'workflow node run % identity columns are immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'skipped', 'cancelled') THEN
    IF NEW.state IS DISTINCT FROM OLD.state OR NEW.output_port IS DISTINCT FROM OLD.output_port
       OR NEW.error IS DISTINCT FROM OLD.error OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
       OR (NEW.input IS DISTINCT FROM OLD.input
           AND NOT (jsonb_typeof(NEW.input) = 'object' AND NEW.input ? '$pruned'))
       OR (NEW.output IS DISTINCT FROM OLD.output
           AND NOT (jsonb_typeof(NEW.output) = 'object' AND NEW.output ? '$pruned')) THEN
      RAISE EXCEPTION 'workflow node run % is finished and immutable', OLD.id USING ERRCODE = 'RA000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

---------------------------------------------------------------------------------------------------- follow-ups
-- Work after a top-level run failed (error workflow, failure-streak alert), written in the same statement that ends
-- the run and performed by the tick (exactly once: the error run is unique per failed run, alerts are deduplicated).
CREATE TABLE workflow_run_followups (
  run_id        uuid PRIMARY KEY REFERENCES workflow_runs (id),
  project       text NOT NULL REFERENCES projects (id),
  name          text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]{0,63}$'),
  created_at    timestamptz NOT NULL,
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_at       timestamptz NOT NULL,
  done_at       timestamptz NULL,
  error_run_id  uuid NULL REFERENCES workflow_runs (id),
  alerted       boolean NOT NULL DEFAULT false,
  -- Why nothing was started (missing / archived error workflow, run-as refused …); codes and names only.
  note          text NULL CHECK (note IS NULL OR length(note) <= 500)
);
CREATE INDEX workflow_run_followups_open_idx ON workflow_run_followups (next_at) WHERE done_at IS NULL;
