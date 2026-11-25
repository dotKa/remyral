-- p6-deploy-on-success (ADR-0030, docs/design/p6-deploy-on-success.md): a job may deploy its result automatically
-- when it succeeds. The creator's submission is the approval: one pre-approval row per job, bound to the job, the
-- target kind, the environment and the target snapshot; executed once by the orchestrator tick.

CREATE TABLE job_deploy_on_success (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           uuid NOT NULL UNIQUE REFERENCES jobs (id) ON DELETE CASCADE,
  project          text NOT NULL REFERENCES projects (id),
  -- 'pages' → pages.deploy of the job's site bundle; 'coolify' → coolify.deploy of the environment's resources.
  target           text NOT NULL CHECK (target IN ('pages', 'coolify')),
  env              text NOT NULL CHECK (env IN ('preview', 'production')),
  -- Pages: the site directory (JobSpec.siteBundle.directory).
  directory        text NULL CHECK (directory IS NULL OR length(directory) BETWEEN 1 AND 300),
  -- The configured target at creation (Pages project name / Coolify uuids + tags); compared before running.
  target_snapshot  jsonb NOT NULL CHECK (jsonb_typeof(target_snapshot) = 'object'),
  -- The policy level the creator's submission satisfied (auto < approval < approval_step_up).
  covers           text NOT NULL CHECK (covers IN ('auto', 'approval', 'approval_step_up')),
  approved_by      uuid NOT NULL REFERENCES users (id),
  approved_at      timestamptz NOT NULL,
  step_up_at       timestamptz NULL,
  via              text NOT NULL CHECK (via IN ('api', 'chat', 'automation')),
  -- {chatThreadId, draftId} or {automationId, runId}.
  source           jsonb NULL CHECK (source IS NULL OR jsonb_typeof(source) = 'object'),
  state            text NOT NULL CHECK (state IN ('pending', 'running', 'requested', 'succeeded', 'failed',
                                                  'refused', 'skipped')),
  reason           text NULL CHECK (reason IS NULL OR length(reason) <= 1000),
  ops_action_id    uuid NULL REFERENCES ops_actions (id),
  bundle_sha256    text NULL CHECK (bundle_sha256 IS NULL OR bundle_sha256 ~ '^[0-9a-f]{64}$'),
  url              text NULL CHECK (url IS NULL OR length(url) <= 2048),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NULL,
  claimed_at       timestamptz NULL,
  notified_at      timestamptz NULL,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  finished_at      timestamptz NULL
);
CREATE INDEX job_deploy_on_success_open_idx ON job_deploy_on_success (state, created_at)
  WHERE state IN ('pending', 'running', 'requested');
CREATE INDEX job_deploy_on_success_action_idx ON job_deploy_on_success (ops_action_id)
  WHERE ops_action_id IS NOT NULL;

-- Automation job targets: deploy each run's job on success ({target, env, directory?} + the save-time approval).
ALTER TABLE automations ADD COLUMN deploy_on_success jsonb NULL
  CHECK (deploy_on_success IS NULL OR jsonb_typeof(deploy_on_success) = 'object');

-- Console notification: a deploy on success went live (deploy.failed already exists).
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed', 'deploy.succeeded'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed', 'deploy.succeeded'));
