-- p10-backup-restore (docs/design/p10-backup-restore.md §6): console notifications for a failed / partial / overdue
-- backup and a failed / overdue restore drill. Every existing kind is repeated (the constraint is replaced whole).
-- Migration number 0075: renumber at merge if a parallel change took it (and merge the kind lists).
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed', 'deploy.succeeded', 'chat.watch', 'chat.note',
                  'monitor.down', 'monitor.up', 'budget.paused', 'report.weekly', 'job.waiting',
                  'backup.failed', 'restore_drill.failed'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed', 'deploy.succeeded', 'chat.watch', 'chat.note',
                  'monitor.down', 'monitor.up', 'budget.paused', 'report.weekly', 'job.waiting',
                  'backup.failed', 'restore_drill.failed'));
