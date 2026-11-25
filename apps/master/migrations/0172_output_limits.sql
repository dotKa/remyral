-- p17-output-limits (docs/design/p17-output-limits.md): output file limits of workspace jobs.
--
--  * project_workspaces.output_max_files / output_max_job_bytes: a workspace project may LOWER the server's output
--    file limit (Ayarlar → Sunucu ayarları → İşler, panel key jobs.outputMaxFiles, default 500) and the per-job bytes
--    of the blob store (Ayarlar → Entegrasyonlar → Depolama); NULL: the server value. The ceilings are the protocol's
--    (2000 files, 64 GiB); the effective value is the smaller of server and project.
--  * job_attempts.output_max_files / output_max_job_bytes: the limits in force for one attempt, recorded when it was
--    assigned (the master checks staged chunks, commits and blob grants against them). output_max_files NULL: a worker
--    without output-limits-v1 (the legacy 20 inline + 20 blob files) or not a workspace job.
--
-- Additive. Rollback: an older master ignores the columns (and applies the legacy limits); to remove:
--   ALTER TABLE project_workspaces DROP COLUMN output_max_files, DROP COLUMN output_max_job_bytes;
--   ALTER TABLE job_attempts DROP COLUMN output_max_files, DROP COLUMN output_max_job_bytes;

ALTER TABLE project_workspaces
  ADD COLUMN output_max_files integer NULL CHECK (output_max_files IS NULL OR output_max_files BETWEEN 1 AND 2000),
  ADD COLUMN output_max_job_bytes bigint NULL
    CHECK (output_max_job_bytes IS NULL OR output_max_job_bytes BETWEEN 1048576 AND 68719476736);

ALTER TABLE job_attempts
  ADD COLUMN output_max_files integer NULL CHECK (output_max_files IS NULL OR output_max_files BETWEEN 1 AND 2000),
  ADD COLUMN output_max_job_bytes bigint NULL CHECK (output_max_job_bytes IS NULL OR output_max_job_bytes >= 1);
