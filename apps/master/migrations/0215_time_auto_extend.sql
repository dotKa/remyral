-- p22-timeout-continuity (docs/design/p22-timeout-continuity.md; owner 2026-11-02: "istediğin zaman işlerin süresini
-- uzatabilirsin"): the security policy's `autonomy.autoExtendTime` lets the platform extend a progressing job at its time
-- warning. Such a change is a row of `job_time_limit_changes` like any other, with no person behind it:
--
--  * `via = 'auto'`   the automatic extension (actor_id stays NULL; audited `job.time_limit.auto_extend`). The number of
--                     these rows per job is the cap the platform checks (AUTO_EXTEND_MAX_PER_JOB = 3).
--
-- The policy switch itself needs no migration (presets live in code; a stored document only holds overrides).
--
-- Additive (a wider CHECK). Rollback: an older master never writes 'auto' and reads such rows as any other change;
-- to remove (after deleting or relabelling the 'auto' rows):
--   ALTER TABLE job_time_limit_changes DROP CONSTRAINT job_time_limit_changes_via_check;
--   ALTER TABLE job_time_limit_changes ADD CONSTRAINT job_time_limit_changes_via_check CHECK (via IN ('console', 'chat'));

ALTER TABLE job_time_limit_changes DROP CONSTRAINT job_time_limit_changes_via_check;
ALTER TABLE job_time_limit_changes
  ADD CONSTRAINT job_time_limit_changes_via_check CHECK (via IN ('console', 'chat', 'auto'));
