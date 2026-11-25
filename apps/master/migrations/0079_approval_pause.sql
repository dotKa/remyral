-- p10-approval-pause (docs/design/p10-approval-pause.md, ADR-0036): a job waiting on an in-run approval is no longer
-- failed by an expiring request. After the project's "stale after" the request and job are marked stale (notification,
-- chat note); after "pause after" the worker stops the runtime, frees the slot and keeps the workspace and the runtime
-- session (job state PAUSED); the request stays open until the retention ends. A decision resumes the same attempt on
-- the same machine under a new fencing epoch.

-- PAUSED is appended (ALTER TYPE … ADD VALUE appends; JOB_STATES in @remana/scheduler lists it last). The new value is
-- not used anywhere else in this file (it cannot be used inside the transaction that adds it).
ALTER TYPE job_state ADD VALUE IF NOT EXISTS 'PAUSED';

-- A paused attempt is open (no lease, no slot): it continues on its machine.
ALTER TABLE job_attempts DROP CONSTRAINT job_attempts_state_check;
ALTER TABLE job_attempts ADD CONSTRAINT job_attempts_state_check CHECK (state IN ('active', 'lost', 'paused', 'ended'));

-- Project → Policy: when a pending in-run approval is marked stale, when the job is paused, how long a paused job (and
-- its kept workspace) waits for a decision before it is cancelled.
ALTER TABLE projects
  ADD COLUMN approval_stale_after_sec integer NOT NULL DEFAULT 900
    CHECK (approval_stale_after_sec BETWEEN 60 AND 86400),
  ADD COLUMN approval_pause_after_sec integer NOT NULL DEFAULT 3600
    CHECK (approval_pause_after_sec BETWEEN 120 AND 86400),
  ADD COLUMN approval_pause_retention_sec integer NOT NULL DEFAULT 604800
    CHECK (approval_pause_retention_sec BETWEEN 3600 AND 604800),
  ADD CONSTRAINT projects_approval_pause_order CHECK (approval_stale_after_sec < approval_pause_after_sec);

-- Requests: the pause markers. `pause_after_at` is set when the request is created for a job whose worker can pause
-- (`approval-pause-v1`): such a request does not expire at its rule's expiry; the master pauses the job instead.
-- `fingerprint` binds a decision to the exact action and inputs (sha256 of the JSON array [action, requested action, summary]): a
-- resumed run may only re-run exactly what was approved.
ALTER TABLE approval_requests
  ADD COLUMN stale_at timestamptz NULL,
  ADD COLUMN pause_after_at timestamptz NULL,
  ADD COLUMN pause_requested_at timestamptz NULL,
  ADD COLUMN fingerprint text NULL CHECK (fingerprint IS NULL OR fingerprint ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT approval_requests_pause_kind CHECK (pause_after_at IS NULL OR kind = 'in_run');

-- The guard of migration 0005, extended: a *pending* request may also be updated while staying pending, but only to set
-- the pause markers once and — when the pause starts — to move `expires_at` out to the pause retention. Everything else
-- stays immutable; a decided request stays fully immutable.
CREATE OR REPLACE FUNCTION approval_requests_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'approval request % is % and immutable', OLD.id, OLD.status USING ERRCODE = 'RA000';
  END IF;
  IF (NEW.id, NEW.job_id, NEW.attempt_id, NEW.epoch, NEW.approval_key, NEW.kind, NEW.action,
      NEW.requested_action, NEW.risk, NEW.summary, NEW.requested_by_type, NEW.requested_by_id, NEW.worker_id,
      NEW.policy_version, NEW.approver_role, NEW.required_approvals, NEW.step_up, NEW.created_at,
      NEW.pause_after_at, NEW.fingerprint)
     IS DISTINCT FROM
     (OLD.id, OLD.job_id, OLD.attempt_id, OLD.epoch, OLD.approval_key, OLD.kind, OLD.action,
      OLD.requested_action, OLD.risk, OLD.summary, OLD.requested_by_type, OLD.requested_by_id, OLD.worker_id,
      OLD.policy_version, OLD.approver_role, OLD.required_approvals, OLD.step_up, OLD.created_at,
      OLD.pause_after_at, OLD.fingerprint) THEN
    RAISE EXCEPTION 'approval request % identity columns are immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF (OLD.stale_at IS NOT NULL AND NEW.stale_at IS DISTINCT FROM OLD.stale_at)
     OR (OLD.pause_requested_at IS NOT NULL AND NEW.pause_requested_at IS DISTINCT FROM OLD.pause_requested_at) THEN
    RAISE EXCEPTION 'approval request % pause markers are set once', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF NEW.expires_at IS DISTINCT FROM OLD.expires_at
     AND NOT (NEW.status = 'pending' AND OLD.pause_requested_at IS NULL AND NEW.pause_requested_at IS NOT NULL
              AND NEW.expires_at > OLD.expires_at) THEN
    RAISE EXCEPTION 'approval request % expiry is immutable (except when its job is paused)', OLD.id
      USING ERRCODE = 'RA000';
  END IF;
  IF NEW.status = 'pending'
     AND (NEW.stale_at, NEW.pause_requested_at) IS NOT DISTINCT FROM (OLD.stale_at, OLD.pause_requested_at) THEN
    RAISE EXCEPTION 'approval request % update must decide it', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE INDEX approval_requests_pause_idx ON approval_requests (pause_after_at)
  WHERE status = 'pending' AND pause_after_at IS NOT NULL;

-- One row per pause episode of a job (at most one open per job). The worker keeps the workspace and session; this row
-- keeps what the resume needs and the pause's own lifecycle:
--   pausing   PAUSE_JOB sent, the run is still stopping
--   paused    the job is PAUSED; waiting for a decision (or for the machine)
--   resuming  decided (or "Resume now"); the dispatcher places the same attempt on the same machine
--   resumed   the attempt runs again (closed)
--   restarted "Restart from scratch" (closed)        cancelled  cancelled / the run ended on its own (closed)
--   expired   the retention ended without a decision; the job was cancelled (closed)
CREATE TABLE job_pauses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              uuid NOT NULL REFERENCES jobs (id),
  attempt_id          uuid NOT NULL,
  worker_id           text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  paused_epoch        integer NOT NULL CHECK (paused_epoch >= 1),
  request_id          uuid NOT NULL REFERENCES approval_requests (id),
  status              text NOT NULL
    CHECK (status IN ('pausing', 'paused', 'resuming', 'resumed', 'restarted', 'cancelled', 'expired')),
  requested_at        timestamptz NOT NULL,
  paused_at           timestamptz NULL,
  retain_until        timestamptz NOT NULL,
  -- From JOB_RESULT.paused.
  resume_mode         text NULL CHECK (resume_mode IS NULL OR resume_mode IN ('session', 'continuation')),
  active_ms           bigint NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  runtime_session_id  text NULL CHECK (runtime_session_id IS NULL OR runtime_session_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- The human decision taken while paused (copied from the request when it closed).
  decision            text NULL CHECK (decision IS NULL OR decision IN ('approve', 'deny')),
  decided_by          uuid NULL REFERENCES users (id),
  decision_reason     text NULL CHECK (decision_reason IS NULL OR length(decision_reason) <= 1000),
  resume_requested_at timestamptz NULL,
  resume_requested_by uuid NULL REFERENCES users (id),
  -- The machine is gone or the kept workspace is missing: only "Restart from scratch" or "Cancel" remain.
  blocked_reason      text NULL CHECK (blocked_reason IS NULL OR length(blocked_reason) <= 500),
  resumed_epoch       integer NULL,
  -- One-shot carry-over: a resumed attempt's identical request (same fingerprint) was answered from this decision;
  -- `carryover_key` is that request's approval id, so a duplicate delivery gets the same answer.
  carryover_used_at   timestamptz NULL,
  carryover_key       text NULL CHECK (carryover_key IS NULL OR carryover_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- Notices sent once each (stale is on the request).
  paused_notified_at  timestamptz NULL,
  ended_at            timestamptz NULL,
  end_reason          text NULL CHECK (end_reason IS NULL OR length(end_reason) <= 500),
  FOREIGN KEY (attempt_id, job_id) REFERENCES job_attempts (id, job_id),
  CHECK ((status IN ('resumed', 'restarted', 'cancelled', 'expired')) = (ended_at IS NOT NULL)),
  CHECK (status = 'pausing' OR paused_at IS NOT NULL OR status IN ('cancelled', 'expired')),
  CHECK (decision IS NULL OR decided_by IS NOT NULL OR decision = 'deny')
);

CREATE UNIQUE INDEX job_pauses_one_open_idx ON job_pauses (job_id) WHERE ended_at IS NULL;
CREATE INDEX job_pauses_status_idx ON job_pauses (status, retain_until) WHERE ended_at IS NULL;
CREATE INDEX job_pauses_request_idx ON job_pauses (request_id);

-- Paused time does not count against the job's run time (shown on the job page); summed from closed episodes.
-- (No column on jobs: the spec is immutable and the store owns the row; job_pauses is the record.)

-- Console notifications: an approval is still waiting (stale) / a job was paused waiting for one / a paused job cannot
-- resume (machine gone). Every existing kind is repeated (the constraint is replaced whole).
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed', 'deploy.succeeded', 'chat.watch', 'chat.note',
                  'monitor.down', 'monitor.up', 'budget.paused', 'report.weekly', 'job.waiting',
                  'backup.failed', 'restore_drill.failed', 'verify.failed', 'deploy.unhealthy',
                  'approval.stale', 'job.paused'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed', 'deploy.succeeded', 'chat.watch', 'chat.note',
                  'monitor.down', 'monitor.up', 'budget.paused', 'report.weekly', 'job.waiting',
                  'backup.failed', 'restore_drill.failed', 'verify.failed', 'deploy.unhealthy',
                  'approval.stale', 'job.paused'));

-- Chat: the assistant may draft "resume / restart from scratch" of a paused job (the user confirms the card).
ALTER TABLE chat_drafts DROP CONSTRAINT chat_drafts_kind_check;
ALTER TABLE chat_drafts ADD CONSTRAINT chat_drafts_kind_check
  CHECK (kind IN ('job', 'workflow_run', 'worker_config', 'approval_decision', 'job_message', 'machine_task',
                  'tool_install', 'skill', 'automation', 'automation_change', 'ops_action', 'monitor',
                  'job_resume'));
