-- p5-full-access (ADR-0020, docs/design/p5-full-access.md): owner-controlled full permission.
--
--  * projects.auto_approve_execution: the project allows jobs with approvalPolicy "allow-all" (no runtime tool call
--    asks; the platform's own gates — protected merge, force push, deploy, credential vault — stay). Changed only
--    through PUT /projects/:id/execution (admin + always-fresh step-up), audited, owners/admins notified.
--  * notifications kind + project.execution: owners/admins learn every change of a project's execution policy
--    (host execution, unconfined, auto-approve); enabling unconfined or auto-approve is critical.

ALTER TABLE projects ADD COLUMN auto_approve_execution boolean NOT NULL DEFAULT false;

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution'));

ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution'));
