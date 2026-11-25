-- p6-approval-mode-switch (docs/design/p6-approval-mode-switch.md): a job's approval mode can change before it
-- starts and while it runs. The spec stays immutable (jobs_guard_update); every change is one row here, numbered
-- per job (seq 1, 2, …). The job's effective mode is the to_mode of its highest seq, else spec.approvalPolicy.
-- A row is written once by the master; only the worker's answer (application, detail, applied_at) is filled in
-- later, once. Additive only.
CREATE TABLE job_approval_mode_changes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             uuid NOT NULL REFERENCES jobs (id),
  seq                integer NOT NULL CHECK (seq >= 1),
  from_mode          text NOT NULL CHECK (from_mode IN ('ask-all', 'ask-sensitive', 'deny-sensitive', 'allow-all')),
  to_mode            text NOT NULL CHECK (to_mode IN ('ask-all', 'ask-sensitive', 'deny-sensitive', 'allow-all')),
  actor_id           uuid NOT NULL REFERENCES users (id),
  job_state          text NOT NULL,
  attempt_id         uuid NULL,
  epoch              integer NULL CHECK (epoch IS NULL OR epoch >= 0),
  worker_id          text NULL CHECK (worker_id IS NULL OR worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- not_running: no live attempt (the next ASSIGN_JOB carries the mode); sent: SET_APPROVAL_POLICY queued.
  delivery           text NOT NULL CHECK (delivery IN ('not_running', 'sent')),
  application        text NULL CHECK (application IN ('live', 'gate', 'partial', 'next_turn', 'refused')),
  application_detail text NULL CHECK (application_detail IS NULL OR length(application_detail) <= 2000),
  applied_at         timestamptz NULL,
  pending_resolved   integer NOT NULL DEFAULT 0 CHECK (pending_resolved >= 0),
  reason             text NULL CHECK (reason IS NULL OR length(reason) <= 1000),
  created_at         timestamptz NOT NULL,
  UNIQUE (job_id, seq),
  CHECK (from_mode <> to_mode),
  CHECK (delivery = 'not_running' OR (attempt_id IS NOT NULL AND epoch IS NOT NULL AND worker_id IS NOT NULL))
);

CREATE INDEX job_approval_mode_changes_job_idx ON job_approval_mode_changes (job_id, seq DESC);

-- Append-only, except that the worker's answer is recorded once.
CREATE FUNCTION job_approval_mode_changes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'job approval mode changes are append-only' USING ERRCODE = 'RA000';
  END IF;
  IF OLD.application IS NOT NULL THEN
    RAISE EXCEPTION 'approval mode change % already has its answer', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF (NEW.id, NEW.job_id, NEW.seq, NEW.from_mode, NEW.to_mode, NEW.actor_id, NEW.job_state, NEW.attempt_id,
      NEW.epoch, NEW.worker_id, NEW.delivery, NEW.pending_resolved, NEW.reason, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.job_id, OLD.seq, OLD.from_mode, OLD.to_mode, OLD.actor_id, OLD.job_state, OLD.attempt_id,
      OLD.epoch, OLD.worker_id, OLD.delivery, OLD.pending_resolved, OLD.reason, OLD.created_at) THEN
    RAISE EXCEPTION 'approval mode change % is immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_approval_mode_changes_update
  BEFORE UPDATE OR DELETE ON job_approval_mode_changes
  FOR EACH ROW EXECUTE FUNCTION job_approval_mode_changes_guard();
CREATE TRIGGER job_approval_mode_changes_no_truncate
  BEFORE TRUNCATE ON job_approval_mode_changes
  FOR EACH STATEMENT EXECUTE FUNCTION job_approval_mode_changes_guard();
REVOKE DELETE, TRUNCATE ON job_approval_mode_changes FROM PUBLIC;
