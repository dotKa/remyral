-- p11-runtime-advice (docs/design/p11-runtime-advice.md, ADR-0044): learn from finished jobs which runtime does well
-- for which kind of work in a project, show it as advice, and (per project opt-in) route jobs submitted with runtime
-- "auto" by expected outcome. Migration number 0093 (0090–0092 = parallel p11 work; renumber at merge if taken).
-- Additive only; older masters ignore every table below.

-- The job's classification (kind + area + the signals that fired), written when the job is created and again when it
-- ends (then with the paths its result touched). One row per job; `stage` says which classification is stored.
CREATE TABLE job_classifications (
  job_id         uuid PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  project        text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  kind           text NULL CHECK (kind IS NULL OR kind IN ('plan', 'execute', 'verify', 'summarise', 'research', 'chore')),
  kind_source    text NULL CHECK (kind_source IS NULL OR kind_source IN ('explicit', 'inferred')),
  area           text NULL CHECK (area IS NULL OR area IN ('frontend', 'backend', 'tests', 'docs', 'infra')),
  area_source    text NULL CHECK (area_source IS NULL OR area_source IN
                   ('explicit', 'touched-paths', 'paths-hint', 'file-types', 'prompt', 'template')),
  -- [{source, area, weight, detail}] (bounded, text only) and {area: score}.
  signals        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(signals) = 'array' AND octet_length(signals::text) <= 16000),
  scores         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scores) = 'object'),
  stage          text NOT NULL CHECK (stage IN ('submitted', 'final', 'backfill')),
  classified_at  timestamptz NOT NULL
);
CREATE INDEX job_classifications_project_area ON job_classifications (project, area);

-- One row per finished job (SUCCEEDED / FAILED; cancelled jobs say nothing about a runtime). The later signals
-- (verification, CI, merge, rerun, rating) are joined when the statistics are read, so they never go stale.
CREATE TABLE job_outcomes (
  job_id         uuid PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  project        text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- The runtime / model the last attempt actually ran with (a usage-limit fallback counts for the fallback).
  runtime        text NOT NULL CHECK (runtime ~ '^[a-z0-9-]{1,32}$'),
  model          text NOT NULL DEFAULT '' CHECK (length(model) <= 128),
  kind           text NULL CHECK (kind IS NULL OR kind IN ('plan', 'execute', 'verify', 'summarise', 'research', 'chore')),
  area           text NULL CHECK (area IS NULL OR area IN ('frontend', 'backend', 'tests', 'docs', 'infra')),
  -- false until the classifier ran for the row (backfilled history is classified by the master after start).
  classified     boolean NOT NULL DEFAULT false,
  succeeded      boolean NOT NULL,
  duration_sec   double precision NULL CHECK (duration_sec IS NULL OR duration_sec >= 0),
  cost_usd       numeric(20, 9) NULL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  prompt_digest  text NULL CHECK (prompt_digest IS NULL OR prompt_digest ~ '^sha256:[a-f0-9]{64}$'),
  ended_at       timestamptz NOT NULL
);
CREATE INDEX job_outcomes_project_ended ON job_outcomes (project, ended_at DESC);
CREATE INDEX job_outcomes_area_ended ON job_outcomes (area, ended_at DESC);
CREATE INDEX job_outcomes_unclassified ON job_outcomes (ended_at DESC) WHERE NOT classified;

-- A human 👍 / 👎 on a finished job (Job page). One per job; the latest wins; audited.
CREATE TABLE job_ratings (
  job_id     uuid PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  rating     smallint NOT NULL CHECK (rating IN (-1, 1)),
  rated_by   uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  rated_at   timestamptz NOT NULL
);

-- Auto mode: how the runtime of a job submitted with runtime "auto" was chosen ("chosen because …").
CREATE TABLE job_runtime_decisions (
  job_id      uuid PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  project     text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  runtime     text NOT NULL CHECK (runtime ~ '^[a-z0-9-]{1,32}$'),
  how         text NOT NULL CHECK (how IN ('best', 'explore', 'fallback')),
  area        text NULL CHECK (area IS NULL OR area IN ('frontend', 'backend', 'tests', 'docs', 'infra')),
  kind        text NULL,
  -- ["…"] reasons and [{runtime, n, rate, excluded}] (bounded).
  reasons     jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array' AND octet_length(reasons::text) <= 8000),
  considered  jsonb NOT NULL CHECK (jsonb_typeof(considered) = 'array' AND octet_length(considered::text) <= 8000),
  decided_at  timestamptz NOT NULL
);

-- Per project settings (Projects → Policy → Runtime advice). No row = the defaults (advice on, auto off).
CREATE TABLE runtime_advice_settings (
  project            text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  mode               text NOT NULL CHECK (mode IN ('off', 'advice', 'auto')),
  exploration_pct    smallint NOT NULL CHECK (exploration_pct BETWEEN 0 AND 30),
  min_samples        smallint NOT NULL CHECK (min_samples BETWEEN 3 AND 100),
  allowed_runtimes   text[] NOT NULL DEFAULT '{}' CHECK (cardinality(allowed_runtimes) <= 8),
  allow_paid         boolean NOT NULL DEFAULT false,
  half_life_days     smallint NOT NULL CHECK (half_life_days BETWEEN 7 AND 365),
  rerun_window_days  smallint NOT NULL CHECK (rerun_window_days BETWEEN 0 AND 30),
  area_rules         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(area_rules) = 'array' AND octet_length(area_rules::text) <= 32000),
  updated_by         uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL
);

-- Back-fill the outcomes of finished jobs from history (agent jobs only; unclassified until the master's backfill
-- classifies them from the prompt and the paths their result changed).
INSERT INTO job_outcomes (job_id, project, runtime, model, succeeded, duration_sec, cost_usd, prompt_digest, ended_at)
SELECT j.id, j.project, j.spec->>'runtime', COALESCE(left(j.spec->>'model', 128), ''), j.state = 'SUCCEEDED',
       (SELECT sum(extract(epoch FROM (a.ended_at - a.started_at)))
          FROM job_attempts a WHERE a.job_id = j.id AND a.ended_at IS NOT NULL),
       (SELECT sum(u.cost_usd) FROM usage_records u WHERE u.job_id = j.id),
       j.prompt_digest, j.state_changed_at
  FROM jobs j
 WHERE j.state IN ('SUCCEEDED', 'FAILED')
   AND COALESCE(j.spec->>'kind', '') NOT IN ('machine-admin', 'integration')
   AND (j.spec->>'runtime') ~ '^[a-z0-9-]{1,32}$'
ON CONFLICT (job_id) DO NOTHING;
