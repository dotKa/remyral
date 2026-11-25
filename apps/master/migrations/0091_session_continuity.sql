-- p11-session-continuity (docs/design/p11-session-continuity.md, ADR-0042): a running attempt survives a worker restart.
-- The worker checkpoints the attempt while it runs (hidden-ref WIP commits / snapshot manifests on its own disk) and
-- reports each checkpoint (metadata only); after a restart it reports the attempt as resumable and the master parks the
-- job (PAUSED, pause episode cause `worker_restart`) and resumes the same attempt on the same machine under a new epoch.
-- Additive only: older code ignores the new table, column and cause value. Migration number 0091 (0090 / 0092 / 0093 =
-- parallel p11 work).

-- One row per checkpoint the worker reported (CHECKPOINT_REPORT, fenced by the live lease). At most the newest 50 per
-- attempt are kept (older rows are deleted by the service).
CREATE TABLE attempt_checkpoints (
  attempt_id          uuid NOT NULL,
  job_id              uuid NOT NULL REFERENCES jobs (id),
  n                   integer NOT NULL CHECK (n >= 1 AND n <= 999999),
  epoch               integer NOT NULL CHECK (epoch >= 1),
  worker_id           text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  taken_at            timestamptz NOT NULL,
  received_at         timestamptz NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('git', 'snapshot')),
  ref                 text NULL CHECK (ref IS NULL OR ref ~ '^refs/remana/checkpoints/[A-Za-z0-9_.:-]{1,128}/[0-9]{1,6}$'),
  commit_sha          text NULL CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  files               integer NOT NULL CHECK (files >= 0),
  bytes               bigint NOT NULL CHECK (bytes >= 0),
  runtime_session_id  text NULL CHECK (runtime_session_id IS NULL OR runtime_session_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  last_tool           jsonb NULL CHECK (last_tool IS NULL OR jsonb_typeof(last_tool) = 'object'),
  in_flight           integer NOT NULL DEFAULT 0 CHECK (in_flight >= 0),
  active_ms           bigint NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  PRIMARY KEY (attempt_id, n),
  FOREIGN KEY (attempt_id, job_id) REFERENCES job_attempts (id, job_id)
);
CREATE INDEX attempt_checkpoints_job_idx ON attempt_checkpoints (job_id, taken_at DESC);

-- Worker-restart pauses reuse the p10 pause episodes (PAUSED, kept workspace, resume on the same machine). They have no
-- approval request and resume at once (resume_at = when the restart was detected); `restart` keeps what the worker
-- reported (checkpoint, restarts, tool calls with unknown outcome) for the job page and the timeline.
ALTER TABLE job_pauses DROP CONSTRAINT IF EXISTS job_pauses_cause_check;
ALTER TABLE job_pauses
  ADD CONSTRAINT job_pauses_cause_check CHECK (cause IN ('approval', 'usage_limit', 'worker_restart')),
  ADD COLUMN restart jsonb NULL CHECK (restart IS NULL OR jsonb_typeof(restart) = 'object'),
  ADD CONSTRAINT job_pauses_restart_facts CHECK (cause <> 'worker_restart' OR restart IS NOT NULL);
CREATE INDEX job_pauses_worker_restart_idx ON job_pauses (job_id) WHERE cause = 'worker_restart';
