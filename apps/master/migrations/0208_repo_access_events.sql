-- p22-git-preflight (docs/design/p22-git-preflight.md): a repository job whose repository the platform cannot read
-- with what it would hand the worker (no credential for a private repository, a GitHub / GitLab / Bitbucket
-- connection that no longer reaches it) fails before dispatch, without starting a runtime. The job timeline shows why
-- and what to fix: a `job_auto_events` row of the new kind `repo_access` (detail: the reason code, the host, the
-- credential path — identifiers only, never a token or provider text).
--
-- Additive. Rollback: an older master never writes the kind; to remove it:
--   DELETE FROM job_auto_events WHERE kind = 'repo_access';
--   ALTER TABLE job_auto_events DROP CONSTRAINT job_auto_events_kind_check;
--   ALTER TABLE job_auto_events ADD CONSTRAINT job_auto_events_kind_check
--     CHECK (kind IN ('auto_approved', 'auto_retry', 'base_ref', 'auto_rebase', 'auto_fix', 'retry_exhausted'));

ALTER TABLE job_auto_events DROP CONSTRAINT job_auto_events_kind_check;
ALTER TABLE job_auto_events ADD CONSTRAINT job_auto_events_kind_check
  CHECK (kind IN ('auto_approved', 'auto_retry', 'base_ref', 'auto_rebase', 'auto_fix', 'retry_exhausted',
                  'repo_access'));
