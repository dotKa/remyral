-- p5-composer / p5-fleet-ui (docs/design/p5-composer.md §4, docs/design/p5-fleet-ui.md §3). Additive only.

-- Scheduled job submissions and workflow runs: run once at a time, or on a 5-field cron (UTC). Rows are
-- written only through src/schedules (ScheduleService); the sweeper is an orchestrator tick step.
CREATE TABLE job_schedules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project              text NOT NULL REFERENCES projects (id),
  name                 text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  target_kind          text NOT NULL CHECK (target_kind IN ('job', 'workflow')),
  -- target_kind = job: the validated protocol JobSpec (same at-rest treatment as jobs.spec) and priority.
  job_spec             jsonb NULL CHECK (job_spec IS NULL OR jsonb_typeof(job_spec) = 'object'),
  priority             integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  -- target_kind = workflow: a definition version of the same project, its inputs and repository override.
  workflow_id          uuid NULL REFERENCES workflow_definitions (id),
  workflow_inputs      jsonb NULL CHECK (workflow_inputs IS NULL OR jsonb_typeof(workflow_inputs) = 'object'),
  workflow_repository  jsonb NULL CHECK (workflow_repository IS NULL OR jsonb_typeof(workflow_repository) = 'object'),
  CHECK ((target_kind = 'job') = (job_spec IS NOT NULL)),
  CHECK ((target_kind = 'workflow') = (workflow_id IS NOT NULL)),
  -- Exactly one trigger: a single time, or a cron expression (minute hour day-of-month month day-of-week, UTC).
  run_at               timestamptz NULL,
  cron                 text NULL CHECK (cron IS NULL OR length(cron) BETWEEN 9 AND 120),
  CHECK ((run_at IS NULL) <> (cron IS NULL)),
  -- active: will fire at next_run_at; done: a one-shot fired; cancelled: by a user; failed: the creator lost
  -- the right to submit (re-checked at every fire) or the target became invalid.
  state                text NOT NULL CHECK (state IN ('active', 'done', 'cancelled', 'failed')),
  CHECK ((state = 'active') = (next_run_at IS NOT NULL)),
  next_run_at          timestamptz NULL,
  last_run_at          timestamptz NULL,
  -- firing: claimed, submission in progress (a crash here skips this occurrence: at-most-once, never twice).
  last_status          text NULL CHECK (last_status IN ('firing', 'created', 'failed')),
  last_job_id          uuid NULL,
  last_run_id          uuid NULL,
  last_error           text NULL CHECK (length(last_error) <= 1000),
  run_count            integer NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  created_by           uuid NOT NULL REFERENCES users (id),
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  cancelled_by         uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  cancelled_at         timestamptz NULL
);
CREATE INDEX job_schedules_due_idx ON job_schedules (next_run_at) WHERE state = 'active';
CREATE INDEX job_schedules_project_idx ON job_schedules (project, created_at DESC);

-- p5-fleet-ui: the last CAPABILITIES.sandboxReadiness ([{profile, ready, runtimes?, reason?}]); untrusted,
-- informational (placement uses sandbox_profiles).
ALTER TABLE workers
  ADD COLUMN sandbox_readiness jsonb NULL
    CHECK (sandbox_readiness IS NULL OR jsonb_typeof(sandbox_readiness) = 'array');
-- (Per-worker state history reads audit events by target: audit_events_target_idx from 0008 covers it.)
