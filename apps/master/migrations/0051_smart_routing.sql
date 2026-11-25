-- p6-smart-routing (docs/design/p6-smart-routing.md): routing rules per job kind, the job_stats outcome rollup and
-- the scheduler's "chosen because …" explanation.

-- Routing rules: job kind → preferred model catalog profile and runtime order. project '' = global
-- (Settings → Models → Routing); otherwise a per-project override that replaces the global rule of that kind.
CREATE TABLE routing_rules (
  project        text NOT NULL DEFAULT '' CHECK (project = '' OR project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  role           text NOT NULL CHECK (role IN ('plan', 'execute', 'verify', 'summarise', 'research', 'chore')),
  model_profile  text NULL REFERENCES model_catalog (id),
  -- Runtimes in order of preference (JSON array of runtime kinds, at most 4, may be empty).
  runtimes       jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(runtimes) = 'array' AND jsonb_array_length(runtimes) <= 4),
  updated_at     timestamptz NOT NULL,
  updated_by     uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  PRIMARY KEY (project, role),
  -- A rule that says nothing is deleted instead of stored.
  CHECK (model_profile IS NOT NULL OR jsonb_array_length(runtimes) > 0)
);

-- Outcome rollup, maintained incrementally in the transaction that ends an attempt (succeeded / failed / retry;
-- cancelled and declined attempts are not counted). One row per project × runtime × model × kind × machine.
-- model '' = the worker's own default model; kind '' = unclassified.
CREATE TABLE job_stats (
  project            text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  runtime            text NOT NULL CHECK (runtime ~ '^[a-z0-9-]{1,32}$'),
  model              text NOT NULL CHECK (length(model) <= 128),
  kind               text NOT NULL CHECK (kind IN ('', 'plan', 'execute', 'verify', 'summarise', 'research', 'chore')),
  worker_id          text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  succeeded          integer NOT NULL DEFAULT 0 CHECK (succeeded >= 0),
  failed             integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  -- Attempt durations as counts per fixed bucket (upper bounds in seconds: 30, 60, 120, 300, 600, 900, 1800,
  -- 3600, 7200, 14400, +inf); p50 / p90 are estimated from it (apps/master/src/routing/stats.ts).
  duration_hist      integer[] NOT NULL CHECK (cardinality(duration_hist) = 11),
  duration_sum_sec   double precision NOT NULL DEFAULT 0 CHECK (duration_sum_sec >= 0),
  -- Dollar cost and tokens reported by the runtime for counted attempts (cost_attempts: attempts with a cost).
  cost_usd           numeric(20, 9) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  cost_attempts      integer NOT NULL DEFAULT 0 CHECK (cost_attempts >= 0),
  input_tokens       bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens      bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  first_at           timestamptz NOT NULL,
  last_at            timestamptz NOT NULL,
  PRIMARY KEY (project, runtime, model, kind, worker_id),
  CHECK (attempts = succeeded + failed)
);
-- Placement reads one runtime × model × kind across machines (and projects).
CREATE INDEX job_stats_lookup ON job_stats (runtime, model, kind, worker_id);

-- The scheduler's explanation of its choice (placed only; NULL for older rows and other statuses).
ALTER TABLE job_schedule_status ADD COLUMN explanation text NULL
  CHECK (explanation IS NULL OR length(explanation) <= 1000);
