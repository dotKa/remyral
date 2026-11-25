-- p4-scheduler: worker project policy, reported local allowlist, and the scheduler's latest verdict per
-- job (actionable reasons shown by GET /jobs/:id). Design: docs/design/p4-orchestration.md §4.

ALTER TABLE workers
  -- Master-side policy: projects this worker may run (NULL = not restricted by the master; the worker's
  -- own repository allowlist still applies). Pushed to the worker as UPDATE_POLICY in a later task.
  ADD COLUMN allowed_projects jsonb NULL
    CHECK (allowed_projects IS NULL OR jsonb_typeof(allowed_projects) = 'array'),
  -- Projects of the worker's local repository allowlist (CAPABILITIES.projects; NULL = not reported).
  ADD COLUMN local_projects jsonb NULL
    CHECK (local_projects IS NULL OR jsonb_typeof(local_projects) = 'array');

CREATE TABLE job_schedule_status (
  job_id        uuid PRIMARY KEY REFERENCES jobs (id),
  -- placed: a lease was granted to worker_id; waiting: feasible but no worker free now;
  -- infeasible: no worker can ever run it as configured (the job was failed with trigger `infeasible`).
  status        text NOT NULL CHECK (status IN ('placed', 'waiting', 'infeasible')),
  -- [{code, permanent, message, workers[]}] (ReasonSummary from @remana/scheduler).
  reasons       jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),
  worker_id     text NULL CHECK (worker_id IS NULL OR worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  evaluated_at  timestamptz NOT NULL
);

-- p3-sandbox (ADR-0007): a project must explicitly opt in to host-native execution profiles
-- (host-restricted / runtime-sandbox). Sent to the worker with ASSIGN_JOB; the worker refuses host profiles
-- without it. Default off (container only). Set by an admin (projects API, p5) — not by job submitters.
ALTER TABLE projects ADD COLUMN host_execution boolean NOT NULL DEFAULT false;
