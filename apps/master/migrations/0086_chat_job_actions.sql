-- p10-chat-job-actions (docs/design/p10-chat-job-actions.md): the ops chat drafts management actions on existing jobs
-- (cancel, run again, continue, class, queue position, run now) as `job_action` cards; the user confirms them and the
-- master runs the Jobs UI's own service calls per job with the confirming user's permissions. Migration number 0086
-- (0084 / 0085 = parallel p10 work; renumber at merge if taken — and keep every kind of the newest constraint).
-- Additive only: the kind list of 0079 plus `job_action`.
ALTER TABLE chat_drafts DROP CONSTRAINT chat_drafts_kind_check;
ALTER TABLE chat_drafts ADD CONSTRAINT chat_drafts_kind_check
  CHECK (kind IN ('job', 'workflow_run', 'worker_config', 'approval_decision', 'job_message', 'machine_task',
                  'tool_install', 'skill', 'automation', 'automation_change', 'ops_action', 'monitor',
                  'job_resume', 'job_action'));
