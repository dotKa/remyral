-- p17-runtime-verify review fix (docs/design/p17-runtime-verify.md §4): the runtime version capability evidence uses.
--
--  * worker_runtimes.evidence_version: the version the adapter's own probe reads (CAPABILITIES runtime
--    `evidenceVersion`). It differs from `version` (the CLI's or the managed install's) for Claude Code driven by an
--    agent SDK other than the pinned one (`<cli>+sdk.<sdk>`). The verify op asks for it, the evidence names it and the
--    tuple lookups (placement, the matrix, ASSIGN_JOB verifiedCapabilities) use it. NULL: an older worker — `version`.
--
-- Additive. Rollback: an older master ignores the column; to remove:
--   ALTER TABLE worker_runtimes DROP COLUMN evidence_version;

ALTER TABLE worker_runtimes
  ADD COLUMN evidence_version text NULL
    CHECK (evidence_version IS NULL OR evidence_version ~ '^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$');
