-- p6-automation-defaults (docs/design/p6-automations.md §11a): unattended runs and approvals.

-- Minutes an automation run may wait for a human approval before its job is cancelled (NULL: no timeout — it waits
-- until the approval itself expires). Existing automations get the default (60) too: none of them should hang.
ALTER TABLE automations ADD COLUMN approval_timeout_minutes integer NULL DEFAULT 60
  CHECK (approval_timeout_minutes IS NULL OR approval_timeout_minutes BETWEEN 5 AND 1440);

-- First time the run was seen waiting for an approval: the "waiting for approval" notification is sent once per run.
ALTER TABLE automation_runs ADD COLUMN approval_waiting_at timestamptz NULL;

-- Waiting notifications (design §11a).
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting'));
