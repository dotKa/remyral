-- p6-deploy-pipeline (ADR-0028 phase 2, docs/design/p6-deploy-integrations.md §8): ops actions requested by workflow
-- deploy steps and automations, static site bundles from jobs, deploy notifications and background status polling.

-- Who asked, beyond the requester: {automationId, runId} or {workflowRunId, nodeId}; and the workflow channel.
ALTER TABLE ops_actions ADD COLUMN source jsonb NULL CHECK (source IS NULL OR jsonb_typeof(source) = 'object');
ALTER TABLE ops_actions DROP CONSTRAINT ops_actions_via_check;
ALTER TABLE ops_actions ADD CONSTRAINT ops_actions_via_check CHECK (via IN ('api', 'chat', 'automation', 'workflow'));
-- Background status polling of `deploying` actions (last poll time).
ALTER TABLE ops_actions ADD COLUMN polled_at timestamptz NULL;
CREATE INDEX ops_actions_deploying_idx ON ops_actions (polled_at NULLS FIRST) WHERE state = 'deploying';

-- Automations whose target is an ops action (coolify.deploy / coolify.restart with fixed parameters).
ALTER TABLE automations DROP CONSTRAINT automations_target_kind_check;
ALTER TABLE automations ADD CONSTRAINT automations_target_kind_check
  CHECK (target_kind IN ('job', 'workflow', 'deploy'));
ALTER TABLE automations ADD COLUMN deploy_action jsonb NULL
  CHECK (deploy_action IS NULL OR jsonb_typeof(deploy_action) = 'object');
ALTER TABLE automations ADD CONSTRAINT automations_deploy_target_check
  CHECK ((target_kind = 'deploy') = (deploy_action IS NOT NULL));
ALTER TABLE automation_runs ADD COLUMN ops_action_id uuid NULL REFERENCES ops_actions (id);

-- Static site bundles (one `site-bundle.json` per attempt, never listed to the console).
ALTER TABLE job_artifacts DROP CONSTRAINT job_artifacts_kind_check;
ALTER TABLE job_artifacts ADD CONSTRAINT job_artifacts_kind_check CHECK (kind IN ('output', 'summary', 'site'));

-- Deploy notifications: an action waits for approval; an action requested by a workflow / automation failed.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed'));
