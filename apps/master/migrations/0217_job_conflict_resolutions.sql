-- p22-conflict-resolve (docs/design/p22-conflict-resolve.md): a verified job whose result conflicts with its target
-- branch gets ONE conflict-resolution job (started by a person from the job page / chat, or by the platform in
-- "Otomatik mod"). It starts from the current target, merges the source job's verified head into its working tree,
-- resolves the conflicts and finishes the original task. When it merges, the source job is superseded (its decision
-- withdrawn, a waiting job cancelled, its pull request closed by the platform).
--
--  * job_conflict_resolutions: at most one row per source job (`skipped` rows remember why auto mode left it alone).
--  * job_auto_events kind 'conflict_resolve' for the job timeline.
--
-- Additive. Rollback: an older master never reads the table or writes the kind; to remove them:
--   DROP TABLE job_conflict_resolutions;
--   DELETE FROM job_auto_events WHERE kind = 'conflict_resolve';
--   ALTER TABLE job_auto_events DROP CONSTRAINT job_auto_events_kind_check;
--   ALTER TABLE job_auto_events ADD CONSTRAINT job_auto_events_kind_check
--     CHECK (kind IN ('auto_approved', 'auto_retry', 'base_ref', 'auto_rebase', 'auto_fix', 'retry_exhausted',
--                     'repo_access'));

CREATE TABLE job_conflict_resolutions (
  source_job_id   uuid PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  resolve_job_id  uuid NULL REFERENCES jobs (id) ON DELETE SET NULL,
  source_head     text NULL CHECK (source_head IS NULL OR source_head ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  state           text NOT NULL CHECK (state IN ('created', 'skipped', 'merged', 'failed')),
  reason          text NULL CHECK (reason IS NULL OR length(reason) <= 500),
  pr_closed       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL,
  finished_at     timestamptz NULL
);
CREATE INDEX job_conflict_resolutions_resolve ON job_conflict_resolutions (resolve_job_id)
  WHERE resolve_job_id IS NOT NULL;

ALTER TABLE job_auto_events DROP CONSTRAINT job_auto_events_kind_check;
ALTER TABLE job_auto_events ADD CONSTRAINT job_auto_events_kind_check
  CHECK (kind IN ('auto_approved', 'auto_retry', 'base_ref', 'auto_rebase', 'auto_fix', 'retry_exhausted',
                  'repo_access', 'conflict_resolve'));
