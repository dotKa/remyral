-- p11-usage-limit-fallback (docs/design/p11-usage-limit-fallback.md, ADR-0040): a runtime that hits its provider's usage
-- limit no longer ends the job FAILED. The project's policy (with a workspace default) decides: wait for the reset (the
-- worker parks the attempt, the job is PAUSED and resumes by itself), continue on a fallback runtime / credential, or
-- fail. One notification per limit hit per store (and one when it resets); the chat assistant can continue on a
-- fallback engine. Additive only: older code ignores the new tables and columns.

-- Workspace default policy (singleton). The JSON is validated by the master (UsageLimitPolicy) before it is written.
CREATE TABLE usage_limit_defaults (
  id          smallint PRIMARY KEY CHECK (id = 1),
  policy      jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  updated_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL
);
INSERT INTO usage_limit_defaults (id, policy, updated_at)
VALUES (1, '{"mode":"auto","maxWaitHours":6,"fallbacks":[],"allowPaidFallback":false}', now());

-- Project policy (NULL = the workspace default applies).
ALTER TABLE projects
  ADD COLUMN usage_limit_policy jsonb NULL
    CHECK (usage_limit_policy IS NULL OR jsonb_typeof(usage_limit_policy) = 'object'),
  ADD COLUMN usage_limit_updated_by uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN usage_limit_updated_at timestamptz NULL;

-- A limit known for one store / credential / model: one open episode per scope key. The first hit notifies; later hits
-- of the same store only extend it; when its resume time passed it ends (and notifies once that it reset).
--   scope_key  worker:<worker>:<runtime>[:<model>] | account:<account>:<runtime> | credential:<key>[:<model>]
CREATE TABLE usage_limit_episodes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key        text NOT NULL CHECK (length(scope_key) BETWEEN 3 AND 400),
  scope            text NOT NULL CHECK (scope IN ('subscription', 'api_credential', 'model')),
  pause_scope      text NOT NULL CHECK (pause_scope IN ('worker_runtime', 'account', 'credential')),
  worker_id        text NULL CHECK (worker_id IS NULL OR worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  runtime          text NOT NULL CHECK (runtime ~ '^[a-z0-9_-]{1,32}$'),
  account_id       text NULL CHECK (account_id IS NULL OR account_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  credential_key   text NULL CHECK (credential_key IS NULL OR length(credential_key) BETWEEN 3 AND 300),
  store            text NULL CHECK (store IS NULL OR store ~ '^[a-z][a-z0-9-]{0,31}$'),
  model            text NULL CHECK (model IS NULL OR model ~ '^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$'),
  kind             text NULL CHECK (kind IS NULL OR kind IN ('session', 'weekly', 'model_weekly', 'spend', 'quota', 'rate')),
  -- What the runtime reported (NULL = not said) and when work may start again (clamped / default backoff).
  reset_at         timestamptz NULL,
  resume_at        timestamptz NOT NULL,
  started_at       timestamptz NOT NULL,
  last_hit_at      timestamptz NOT NULL,
  hits             integer NOT NULL DEFAULT 1 CHECK (hits >= 1),
  first_job_id     uuid NULL REFERENCES jobs (id),
  project          text NULL,
  -- One line of the runtime's text, redacted by the worker (shown as text only).
  message          text NULL CHECK (message IS NULL OR length(message) <= 300),
  notified_at      timestamptz NULL,
  ended_at         timestamptz NULL,
  end_reason       text NULL CHECK (end_reason IS NULL OR length(end_reason) <= 300),
  reset_notified_at timestamptz NULL,
  CHECK ((pause_scope = 'credential') = (credential_key IS NOT NULL)),
  CHECK (pause_scope <> 'account' OR account_id IS NOT NULL),
  CHECK (pause_scope <> 'worker_runtime' OR worker_id IS NOT NULL)
);
CREATE UNIQUE INDEX usage_limit_episodes_open_idx ON usage_limit_episodes (scope_key) WHERE ended_at IS NULL;
CREATE INDEX usage_limit_episodes_resume_idx ON usage_limit_episodes (resume_at) WHERE ended_at IS NULL;

-- One row per limited attempt (JOB_RESULT): the episode it belongs to, the decision and, for a requeued job, when it may
-- run again (promoteRetries holds RETRY_WAIT jobs until then).
CREATE TABLE usage_limit_hits (
  attempt_id   uuid PRIMARY KEY,
  job_id       uuid NOT NULL REFERENCES jobs (id),
  episode_id   uuid NOT NULL REFERENCES usage_limit_episodes (id),
  worker_id    text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  runtime      text NOT NULL CHECK (runtime ~ '^[a-z0-9_-]{1,32}$'),
  action       text NOT NULL CHECK (action IN ('wait', 'fallback', 'fail')),
  -- How the job waits: parked on its machine (PAUSED) or requeued as a new attempt (RETRY_WAIT); NULL for fail.
  path         text NULL CHECK (path IS NULL OR path IN ('parked', 'requeued')),
  reset_at     timestamptz NULL,
  requeue_at   timestamptz NULL,
  policy       jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  created_at   timestamptz NOT NULL,
  FOREIGN KEY (attempt_id, job_id) REFERENCES job_attempts (id, job_id)
);
CREATE INDEX usage_limit_hits_job_idx ON usage_limit_hits (job_id, requeue_at);

-- Usage-limit pauses reuse the p10 pause episodes (PAUSED, parked workspace, resume on the same machine). An approval
-- pause keeps its request; a usage-limit pause has none and carries when to resume and how.
ALTER TABLE job_pauses
  ADD COLUMN cause text NOT NULL DEFAULT 'approval' CHECK (cause IN ('approval', 'usage_limit')),
  ADD COLUMN resume_at timestamptz NULL,
  ADD COLUMN usage_limit jsonb NULL CHECK (usage_limit IS NULL OR jsonb_typeof(usage_limit) = 'object'),
  ADD COLUMN resume_options jsonb NULL CHECK (resume_options IS NULL OR jsonb_typeof(resume_options) = 'array');
ALTER TABLE job_pauses ALTER COLUMN request_id DROP NOT NULL;
ALTER TABLE job_pauses
  ADD CONSTRAINT job_pauses_cause_request CHECK ((cause = 'approval') = (request_id IS NOT NULL)),
  ADD CONSTRAINT job_pauses_usage_limit_resume CHECK (cause = 'approval' OR resume_at IS NOT NULL);
CREATE INDEX job_pauses_usage_limit_idx ON job_pauses (resume_at)
  WHERE ended_at IS NULL AND cause = 'usage_limit';

-- Chat: an optional fallback engine (same machine) and the engines' known limits.
ALTER TABLE chat_settings
  ADD COLUMN fallback_runtime text NULL
    CHECK (fallback_runtime IS NULL OR fallback_runtime IN ('claude-code', 'codex', 'opencode', 'pi')),
  ADD COLUMN fallback_model_profile text NULL
    CHECK (fallback_model_profile IS NULL OR fallback_model_profile ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  ADD CONSTRAINT chat_settings_fallback_distinct CHECK (fallback_runtime IS NULL OR fallback_runtime <> runtime);
CREATE TABLE chat_engine_limits (
  runtime     text NOT NULL CHECK (runtime IN ('claude-code', 'codex', 'opencode', 'pi')),
  worker_id   text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  until       timestamptz NOT NULL,
  reset_at    timestamptz NULL,
  detail      text NULL CHECK (detail IS NULL OR length(detail) <= 500),
  since       timestamptz NOT NULL,
  PRIMARY KEY (runtime, worker_id)
);

-- Notification kinds: appended to whatever the constraints allow now (other migrations of the same release may add
-- kinds too), so the list is read from the current definition instead of being repeated here.
DO $$
DECLARE
  t text;
  c text;
  def text;
  kinds text[];
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_preferences'] LOOP
    c := t || '_kind_check';
    SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
     WHERE conname = c AND conrelid = t::regclass;
    IF def IS NULL THEN
      RAISE EXCEPTION 'constraint % not found', c;
    END IF;
    SELECT array_agg(DISTINCT m[1]) INTO kinds FROM regexp_matches(def, '''([a-z0-9_.]+)''', 'g') AS m;
    kinds := kinds || ARRAY['usage_limit.reached', 'usage_limit.reset'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, c, kinds);
  END LOOP;
END;
$$;
