-- p6-safe-auto-approve (docs/design/p6-safe-auto-approve.md): a project's safe-command mode.
--
--  * off              — every runtime shell command under `ask-sensitive` waits for a human (the behaviour before).
--  * read-only        — commands the classifier proves read-only (inside the job workspace) are approved by the master
--                       and audited as `approval.auto_safe`; writes still ask. Default for existing and new projects.
--  * workspace-writes — also commands that write only inside the job workspace (redirects, New-Item, Set-Content …).
--
-- Only `runtime.dangerous_tool` requests of `ask-sensitive` jobs are affected; merge, push, deploy, deletes outside
-- the workspace and secrets keep their platform floor.
ALTER TABLE projects ADD COLUMN safe_commands text NOT NULL DEFAULT 'read-only'
  CHECK (safe_commands IN ('off', 'read-only', 'workspace-writes'));
