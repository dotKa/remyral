-- p9-queue-priority (docs/design/p9-queue-priority.md, ADR-0033): decline = wait, per-profile slots, priority classes,
-- the urgent slot reservation, the queue screen's reorder / run-now, per-user / per-automation limits and the long-wait
-- notification. Migration number 0071: renumber at merge if a parallel change took it.

-- What a worker reports with `profile-slots-v1`: most concurrent attempts per sandbox profile, and the profiles whose
-- attempt runs only on an otherwise idle worker (T-SBX-4). NULL: not reported (bounded by max_parallel_jobs only).
ALTER TABLE workers ADD COLUMN profile_concurrency jsonb NULL
  CHECK (profile_concurrency IS NULL OR jsonb_typeof(profile_concurrency) = 'object');
ALTER TABLE workers ADD COLUMN exclusive_profiles jsonb NULL
  CHECK (exclusive_profiles IS NULL OR jsonb_typeof(exclusive_profiles) = 'array');
-- Owner decision S1 (5a): slots kept for urgent (Acil) jobs when the machine's effective slots are ≥ 2.
ALTER TABLE workers ADD COLUMN urgent_reserve smallint NOT NULL DEFAULT 1 CHECK (urgent_reserve BETWEEN 0 AND 2);

-- One row per declined attempt: transient (busy — the job waits, the worker is asked again once it runs fewer jobs
-- than `active_leases` or after `retry_at`) or permanent (that worker is never asked again for this job).
-- `classified_by`: the worker's own LEASE_ACK.declineKind, or the master's text match for older workers.
CREATE TABLE job_declines (
  attempt_id    uuid PRIMARY KEY,
  job_id        uuid NOT NULL REFERENCES jobs (id),
  worker_id     text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  kind          text NOT NULL CHECK (kind IN ('transient', 'permanent')),
  classified_by text NOT NULL CHECK (classified_by IN ('worker', 'legacy_text')),
  active_leases integer NOT NULL CHECK (active_leases >= 0),
  retry_at      timestamptz NULL,
  declined_at   timestamptz NOT NULL,
  CHECK ((kind = 'transient') = (retry_at IS NOT NULL))
);
CREATE INDEX job_declines_job_idx ON job_declines (job_id, declined_at DESC);

-- Queue-screen priority adjustments (drag and drop within a class, "run now"): the jobs row is never touched (its
-- version history stays one transition per version); dispatch orders by COALESCE(override, jobs.priority).
CREATE TABLE job_queue_priority (
  job_id     uuid PRIMARY KEY REFERENCES jobs (id),
  priority   smallint NOT NULL CHECK (priority BETWEEN -100 AND 100),
  reason     text NOT NULL CHECK (reason IN ('reorder', 'run_now')),
  set_by     text NOT NULL CHECK (length(set_by) BETWEEN 1 AND 200),
  set_at     timestamptz NOT NULL
);

-- Project queue settings: per-user / per-automation concurrency limits (NULL = off, the default) and the long-wait
-- notification threshold in minutes (0 = off; default 15).
ALTER TABLE projects ADD COLUMN queue_max_per_user smallint NULL
  CHECK (queue_max_per_user IS NULL OR queue_max_per_user BETWEEN 1 AND 100);
ALTER TABLE projects ADD COLUMN queue_max_per_automation smallint NULL
  CHECK (queue_max_per_automation IS NULL OR queue_max_per_automation BETWEEN 1 AND 100);
ALTER TABLE projects ADD COLUMN queue_wait_notify_minutes smallint NOT NULL DEFAULT 15
  CHECK (queue_wait_notify_minutes BETWEEN 0 AND 1440);

-- A workflow run's queue priority (class value or advanced number): every step job of the run gets it.
ALTER TABLE workflow_runs ADD COLUMN priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100);

-- The long-wait notice is sent once per job.
CREATE TABLE job_wait_notices (
  job_id      uuid PRIMARY KEY REFERENCES jobs (id),
  waited_sec  integer NOT NULL CHECK (waited_sec >= 0),
  notified_at timestamptz NOT NULL
);

-- Console notifications: a job has been waiting in the queue longer than its project's threshold.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed', 'deploy.succeeded', 'chat.watch', 'chat.note',
                  'monitor.down', 'monitor.up', 'budget.paused', 'report.weekly', 'job.waiting'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed', 'deploy.succeeded', 'chat.watch', 'chat.note',
                  'monitor.down', 'monitor.up', 'budget.paused', 'report.weekly', 'job.waiting'));
