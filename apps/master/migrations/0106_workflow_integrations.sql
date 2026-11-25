-- p14-workflow-engine 14.2 (ADR-0055 addendum 14.2, docs/design/p14-workflow-engine.md §18): master integrations,
-- webhook waits and trigger nodes. Additive only: nullable columns; older code ignores them (rollback: leave them).
-- Migration number 0106 (0104 is reserved by a parallel change); renumber at merge if needed.

-- 1. The trigger node a run started from (part of the run's identity) and its event data (`$trigger`, untrusted unless
--    a member started it): a stored value (inline ≤ 16 KiB, else `{"$payload": sha}` into workflow_payloads), written
--    once in the run's creation transaction and never changed afterwards.
ALTER TABLE workflow_runs
  ADD COLUMN trigger_node text NULL CHECK (trigger_node IS NULL OR trigger_node ~ '^[a-z][a-z0-9_-]{0,47}$'),
  ADD COLUMN trigger_data jsonb NULL;

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
      NEW.source_trust, NEW.concurrency_key, NEW.trigger_node)
     IS DISTINCT FROM
     (OLD.id, OLD.definition_id, OLD.project, OLD.inputs, OLD.repository, OLD.created_by, OLD.created_at,
      OLD.engine, OLD.parent_run_id, OLD.parent_node_run_id, OLD.rerun_of, OLD.rerun_from_node, OLD.trigger_kind,
      OLD.source_trust, OLD.concurrency_key, OLD.trigger_node) THEN
    RAISE EXCEPTION 'workflow run % identity columns are immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF OLD.trigger_data IS NOT NULL AND NEW.trigger_data IS DISTINCT FROM OLD.trigger_data THEN
    RAISE EXCEPTION 'workflow run % trigger data is immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;

-- 2. A webhook wait may be called before its node starts waiting (the URL is known from the run's start): the
--    received body is kept here (stored value, untrusted) until the node takes it.
ALTER TABLE workflow_waits
  ADD COLUMN received jsonb NULL,
  ADD COLUMN received_at timestamptz NULL,
  ADD CONSTRAINT workflow_waits_received_check CHECK ((received_at IS NULL) = (consumed_at IS NULL));

-- 3. Trigger bindings remember which version / node configuration they were reconciled from ("out of date" on the
--    canvas when the node changed since "Etkinleştir").
ALTER TABLE workflow_trigger_bindings
  ADD COLUMN activated_version integer NULL CHECK (activated_version IS NULL OR activated_version >= 1),
  ADD COLUMN config_hash text NULL CHECK (config_hash IS NULL OR config_hash ~ '^[a-f0-9]{64}$');
