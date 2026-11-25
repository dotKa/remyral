-- p14-web-perf-2 (docs/design/p14-followups.md §3): `GET /jobs/:id/live` counted the job's log chunks with
-- `count(*)` on every call (the job page polls it). The head row now keeps the count, maintained in the same
-- transaction that stores a chunk (the head row is locked there anyway) and reset by the retention purge.
-- Existing heads start NULL ("not counted yet"): the first summary counts them once under the head row lock and
-- stores the number, so the migration does not scan job_log_chunks. Additive only (rollback: older code ignores the
-- column). Migration number 0116 (given in the brief); renumber at merge if needed.

ALTER TABLE job_live_heads ADD COLUMN log_chunk_count bigint NULL CHECK (log_chunk_count IS NULL OR log_chunk_count >= 0);
-- New heads start at 0 (rows inserted from now on); existing rows keep NULL until their first summary.
ALTER TABLE job_live_heads ALTER COLUMN log_chunk_count SET DEFAULT 0;
