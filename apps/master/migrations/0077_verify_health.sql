-- p10-verify-health (docs/design/p10-verify-health.md, ADR-0035): automatic verification of a job's result after it
-- succeeded (a verifier child job with a fixed checklist + deterministic master checks), and a health check after
-- every successful deploy / preview tunnel (guarded probe, same-origin crawl, screenshots, optional auto-rollback).
-- Additive. Migration number 0077 (0075 = p10-backup-restore, 0076 = p10-semantic-memory): renumber at merge if a parallel change
-- took it, and merge the notification kind lists (every kind on main is repeated below). Rows are written only through
-- src/verify.

-- Per project: the default "Verify when done" mode, the verifier runtime and test command, and the post-deploy health
-- check settings. No row = defaults (verification off, health check on, screenshots on, no auto-rollback).
CREATE TABLE project_verify_settings (
  project                  text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  verify_default           text NOT NULL DEFAULT 'off' CHECK (verify_default IN ('off', 'report', 'gate')),
  verify_runtime           text NULL CHECK (verify_runtime IS NULL OR verify_runtime ~ '^[a-z][a-z0-9-]{0,31}$'),
  test_command             text NULL CHECK (test_command IS NULL OR length(test_command) BETWEEN 1 AND 300),
  health_after_deploy      boolean NOT NULL DEFAULT true,
  health_screenshots       boolean NOT NULL DEFAULT true,
  health_keyword           text NULL CHECK (health_keyword IS NULL OR length(health_keyword) BETWEEN 1 AND 100),
  auto_rollback            boolean NOT NULL DEFAULT false,
  auto_rollback_production boolean NOT NULL DEFAULT false,
  updated_by               uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at               timestamptz NOT NULL,
  CHECK (NOT auto_rollback_production OR auto_rollback)
);

-- One verification per job (the job's "Verify when done"). The verifier is an ordinary job (verifier_job_id).
CREATE TABLE job_verifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           uuid NOT NULL UNIQUE REFERENCES jobs (id) ON DELETE CASCADE,
  project          text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  mode             text NOT NULL CHECK (mode IN ('report', 'gate')),
  runtime          text NULL CHECK (runtime IS NULL OR runtime ~ '^[a-z][a-z0-9-]{0,31}$'),
  -- Where the mode came from: the request itself or the project's default.
  source           text NOT NULL CHECK (source IN ('request', 'project', 'template', 'automation', 'chat')),
  created_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  -- Originating chat thread (results are noted there), automation / run ids.
  origin           jsonb NULL CHECK (origin IS NULL OR jsonb_typeof(origin) = 'object'),
  state            text NOT NULL CHECK (state IN ('waiting', 'checking', 'verifying', 'passed', 'warned', 'failed',
                                                  'error', 'skipped')),
  output_type      text NULL CHECK (output_type IS NULL OR output_type IN ('site', 'repo', 'docs', 'none')),
  verifier_job_id  uuid NULL REFERENCES jobs (id) ON DELETE SET NULL,
  -- [{source: master|verifier, id, status, detail}] / [{source, severity, kind, message, url?}] (bounded, text only).
  checks           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checks) = 'array'),
  findings         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  -- [{jobId, artifactId, name, width}] — ordinary job files of the verifier job.
  screenshots      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(screenshots) = 'array'),
  summary          text NULL CHECK (summary IS NULL OR length(summary) <= 1000),
  reason           text NULL CHECK (reason IS NULL OR length(reason) <= 1000),
  claimed_at       timestamptz NULL,
  override_by      uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  override_at      timestamptz NULL,
  override_reason  text NULL CHECK (override_reason IS NULL OR length(override_reason) <= 500),
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  started_at       timestamptz NULL,
  finished_at      timestamptz NULL,
  notified_at      timestamptz NULL,
  CHECK (override_by IS NULL OR override_at IS NOT NULL)
);
CREATE INDEX job_verifications_open ON job_verifications (state, created_at)
  WHERE state IN ('waiting', 'checking', 'verifying');
CREATE INDEX job_verifications_verifier ON job_verifications (verifier_job_id) WHERE verifier_job_id IS NOT NULL;

-- One health check per successful deploy / rollback ops action or per opened preview tunnel.
CREATE TABLE deploy_health_checks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project          text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  ops_action_id    uuid NULL UNIQUE REFERENCES ops_actions (id) ON DELETE CASCADE,
  preview_id       uuid NULL UNIQUE REFERENCES preview_tunnels (id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('pages.deploy', 'pages.rollback', 'coolify.deploy', 'coolify.rollback',
                                                 'tunnel')),
  env              text NULL CHECK (env IS NULL OR env IN ('preview', 'production')),
  url              text NULL CHECK (url IS NULL OR (url ~ '^https?://' AND length(url) <= 2000)),
  protected        boolean NOT NULL DEFAULT false,
  state            text NOT NULL CHECK (state IN ('pending', 'checking', 'browser', 'passed', 'warned', 'failed',
                                                  'error', 'skipped')),
  -- {ok, statusCode, latencyMs, error, detail, tlsExpiresAt, finalUrl} — the guarded probe's result (no body).
  probe            jsonb NULL CHECK (probe IS NULL OR jsonb_typeof(probe) = 'object'),
  -- {pages, assets, external, broken: [{url, status, error, from}], truncated, budgetExhausted}
  links            jsonb NULL CHECK (links IS NULL OR jsonb_typeof(links) = 'object'),
  findings         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  browser_job_id   uuid NULL REFERENCES jobs (id) ON DELETE SET NULL,
  browser_note     text NULL CHECK (browser_note IS NULL OR length(browser_note) <= 500),
  screenshots      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(screenshots) = 'array'),
  rollback_action_id uuid NULL REFERENCES ops_actions (id) ON DELETE SET NULL,
  rollback_note    text NULL CHECK (rollback_note IS NULL OR length(rollback_note) <= 500),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NULL,
  claimed_at       timestamptz NULL,
  rechecked_at     timestamptz NULL,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  finished_at      timestamptz NULL,
  notified_at      timestamptz NULL,
  CHECK ((ops_action_id IS NULL) <> (preview_id IS NULL))
);
CREATE INDEX deploy_health_checks_open ON deploy_health_checks (state, next_attempt_at)
  WHERE state IN ('pending', 'checking', 'browser');
CREATE INDEX deploy_health_checks_project ON deploy_health_checks (project, created_at DESC);
CREATE INDEX deploy_health_checks_browser ON deploy_health_checks (browser_job_id) WHERE browser_job_id IS NOT NULL;

-- An automation's "Verify when done" (null: the project's default).
ALTER TABLE automations
  ADD COLUMN verify_on_success text NULL CHECK (verify_on_success IS NULL OR verify_on_success IN ('off', 'report', 'gate'));

-- Console notifications: a job's verification failed / a deployed site is unhealthy after its deploy. Every existing kind
-- is repeated (the constraint is replaced whole), including p10-backup-restore's backup.failed / restore_drill.failed.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed', 'deploy.succeeded', 'chat.watch', 'chat.note',
                  'monitor.down', 'monitor.up', 'budget.paused', 'report.weekly', 'job.waiting',
                  'backup.failed', 'restore_drill.failed', 'verify.failed', 'deploy.unhealthy'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed', 'deploy.succeeded', 'chat.watch', 'chat.note',
                  'monitor.down', 'monitor.up', 'budget.paused', 'report.weekly', 'job.waiting',
                  'backup.failed', 'restore_drill.failed', 'verify.failed', 'deploy.unhealthy'));
