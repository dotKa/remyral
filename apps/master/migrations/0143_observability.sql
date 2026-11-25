-- p16-observability (docs/design/p16-observability.md): console log search and trace context on durable messages.
-- Additive only.
--
--  * master_log_lines: the master's own recent log lines (already redacted in-process), batched in by the master and
--    deleted after LOG_STORE_RETENTION_DAYS (default 7) or above LOG_STORE_MAX_ROWS. UNLOGGED on purpose: diagnostic
--    lines are not worth WAL — no write amplification, nothing shipped to the warm standby's WAL archive. The price: a
--    Postgres crash (not a clean restart) empties the table; the container log pipeline keeps its own copy. pg_dump
--    still includes the rows (so the restore drill's row counts match); a physical base backup does not.
--  * worker_outbox.traceparent: the W3C trace context of the span that queued a durable master → worker message
--    (ASSIGN_JOB, RENEW_LEASE …), put on the envelope when the message is sent or replayed.
--
-- Rollback: an older master never reads either; drop them if wanted:
--   DROP TABLE master_log_lines;
--   ALTER TABLE worker_outbox DROP COLUMN traceparent;
-- Migration number 0143 (renumbered at merge: 0142 is p16-ops-safety).

CREATE UNLOGGED TABLE master_log_lines (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL,
  level smallint NOT NULL CHECK (level BETWEEN 0 AND 100),
  component text CHECK (component IS NULL OR length(component) <= 64),
  req_id text CHECK (req_id IS NULL OR length(req_id) <= 64),
  job_id text CHECK (job_id IS NULL OR length(job_id) <= 64),
  worker_id text CHECK (worker_id IS NULL OR length(worker_id) <= 64),
  trace_id text CHECK (trace_id IS NULL OR trace_id ~ '^[0-9a-f]{32}$'),
  msg text NOT NULL CHECK (length(msg) <= 2048),
  -- The rest of the (redacted) line, size-capped by the writer.
  fields jsonb
);

CREATE INDEX master_log_lines_at ON master_log_lines (at DESC);
CREATE INDEX master_log_lines_req ON master_log_lines (req_id) WHERE req_id IS NOT NULL;
CREATE INDEX master_log_lines_job ON master_log_lines (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX master_log_lines_trace ON master_log_lines (trace_id) WHERE trace_id IS NOT NULL;

ALTER TABLE worker_outbox ADD COLUMN traceparent text
  CHECK (traceparent IS NULL OR traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');
