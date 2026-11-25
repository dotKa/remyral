-- p4-leases / p4-dispatch / p4-recovery (ADR-0003, ADR-0004): how sequenced worker messages were routed
-- into the job state machine, and per-attempt run facts the reconciler decides on.
-- Design: docs/design/p4-orchestration.md.

-- Routing outcome of every journaled worker message (worker_inbox stays the exactly-once journal).
--   applied:   changed job state (or was accepted as data of the job's current lease)
--   journaled: stored only (no job effect, e.g. a message for an unknown job)
--   stale:     carried an epoch that is not the job's current lease of this worker (ADR-0004 §3) — no effect
--   rejected:  illegal for the job's state (e.g. a result after cancellation was confirmed) — no effect
-- `effect` marks messages with a post-commit effect in another service (usage, approvals, context
-- memory); `effect_status` lets the reconciler retry effects lost to a crash between commit and effect.
ALTER TABLE worker_inbox
  ADD COLUMN outcome         text NOT NULL DEFAULT 'journaled'
                             CHECK (outcome IN ('journaled', 'applied', 'stale', 'rejected')),
  ADD COLUMN outcome_reason  text NULL CHECK (length(outcome_reason) <= 64),
  ADD COLUMN effect          text NULL CHECK (effect IN ('usage', 'approval', 'memory')),
  ADD COLUMN effect_status   text NULL CHECK (effect_status IN ('pending', 'running', 'done', 'failed')),
  -- A runner claims the effect (pending → running) so two runners never apply it concurrently; a claim
  -- older than the retry window is considered lost (crash) and may be taken again.
  ADD COLUMN effect_claimed_at timestamptz NULL,
  ADD COLUMN effect_attempts integer NOT NULL DEFAULT 0 CHECK (effect_attempts >= 0),
  ADD COLUMN effect_error    text NULL CHECK (length(effect_error) <= 64),
  ADD CONSTRAINT worker_inbox_effect_chk CHECK ((effect IS NULL) = (effect_status IS NULL));

CREATE INDEX worker_inbox_effect_pending_idx ON worker_inbox (id) WHERE effect_status IN ('pending', 'running');
CREATE INDEX worker_inbox_job_idx ON worker_inbox (job_id, id) WHERE job_id IS NOT NULL;

-- One row per attempt that was dispatched: what the worker reported, the context it got, and the last
-- reconciliation decision. Mutable bookkeeping; the authoritative history stays job_transitions/audit.
CREATE TABLE job_runs (
  attempt_id          uuid PRIMARY KEY,
  job_id              uuid NOT NULL,
  worker_id           text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- Last `status` phase the runtime reported (starting/running/waiting_approval/verifying/stopping/stopped).
  last_phase          text NULL CHECK (length(last_phase) <= 32),
  -- p6-context-model: hash of the bundle issued with ASSIGN_JOB.
  context_bundle_hash text NULL CHECK (context_bundle_hash ~ '^sha256:[a-f0-9]{64}$'),
  -- JOB_RESULT as reported (validated protocol payload without the lease fields); untrusted (T-WRK-2).
  result_outcome      text NULL CHECK (result_outcome IN ('succeeded', 'failed', 'cancelled')),
  result              jsonb NULL CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  result_epoch        integer NULL CHECK (result_epoch >= 0),
  -- The result arrived after the lease was lost (kept as reconciliation input, ADR-0004 §2).
  result_late         boolean NOT NULL DEFAULT false,
  result_received_at  timestamptz NULL,
  -- Last reconciliation decision {decision, reason, at} (p4-recovery).
  recovery            jsonb NULL CHECK (recovery IS NULL OR jsonb_typeof(recovery) = 'object'),
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  FOREIGN KEY (attempt_id, job_id) REFERENCES job_attempts (id, job_id)
);

CREATE INDEX job_runs_job_idx ON job_runs (job_id, created_at);
