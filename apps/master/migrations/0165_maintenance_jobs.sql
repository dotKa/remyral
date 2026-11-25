-- p17-panel-settings Part 7 (docs/design/p17-panel-settings.md §9): maintenance commands as background jobs started from
-- the panel — `blobs:migrate` (every mode), `search:backfill` (every kind), `memory:autolearn` (all projects) — with a
-- dry run first, progress, cancel and audit. The master that started a job runs it; at most one open job per kind.
--
-- `heartbeat_at` moves while the job runs: an open job whose master stopped (no heartbeat for 2 minutes) is failed
-- ("interrupted") by any instance's tick; the commands are idempotent, so starting it again continues.
--
-- Additive. Rollback: an older master ignores the table. To remove: DROP TABLE maintenance_jobs;
CREATE TABLE maintenance_jobs (
  id               uuid PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN ('blobs-migrate', 'search-backfill', 'memory-autolearn')),
  params           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object'),
  dry_run          boolean NOT NULL,
  state            text NOT NULL CHECK (state IN ('running', 'done', 'failed', 'cancelled')),
  -- { done, total, step, lines[] } — counts and short lines only (never file contents or texts).
  progress         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(progress) = 'object'),
  report           jsonb NULL,
  error            text NULL CHECK (error IS NULL OR char_length(error) <= 500),
  cancel_requested boolean NOT NULL DEFAULT false,
  started_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  started_at       timestamptz NOT NULL,
  heartbeat_at     timestamptz NOT NULL,
  finished_at      timestamptz NULL
);
CREATE UNIQUE INDEX maintenance_jobs_one_running ON maintenance_jobs (kind) WHERE state = 'running';
CREATE INDEX maintenance_jobs_recent ON maintenance_jobs (started_at DESC);
