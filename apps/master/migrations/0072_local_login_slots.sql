-- p9-queue-local-login-accounting (docs/design/p9-queue-priority.md §12): what a worker reports as CAPABILITIES.localLogin
-- with `profile-slots-v1` — the runtimes whose jobs run with its own subscription login and the sandbox profiles in
-- which such an attempt runs one at a time and alone (Windows per-job accounts). NULL: not reported (older workers;
-- their declines tell). Migration number 0072: renumber at merge if a parallel change took it.
ALTER TABLE workers ADD COLUMN local_login jsonb NULL
  CHECK (local_login IS NULL OR jsonb_typeof(local_login) = 'object');

-- Slot accounting looks up a job's transient declines by worker (a re-ask of a busy-declined job holds no slot).
CREATE INDEX job_declines_job_worker_idx ON job_declines (job_id, worker_id) WHERE kind = 'transient';
