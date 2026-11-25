-- p5-live (A-UX-2, T-INJ-4, T-SEC-1): append-only, master-redacted copies of a job's agent events and log
-- chunks for the live view, search and replay-safe resume. Design: docs/design/p5-live.md.
--
-- Rows are written by the OrchestrationInbox inside the worker replay transaction, only for messages whose
-- fence outcome is `applied` (live/closed lease of the sending worker), after the master's pattern
-- redaction pass (ADR-0006 §4 second stage). worker_inbox stays the raw exactly-once journal.

-- Per-job stream sequence. Every live row takes head + 1 under this row's lock, which is held until the
-- inbox transaction commits: per job, stream sequences become visible in strictly increasing order, so a
-- reader that has seen N has seen everything ≤ N (gap-free Last-Event-ID resume).
CREATE TABLE job_live_heads (
  job_id      uuid PRIMARY KEY REFERENCES jobs (id),
  head        bigint NOT NULL CHECK (head >= 0),
  log_bytes   bigint NOT NULL DEFAULT 0 CHECK (log_bytes >= 0),
  event_count integer NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  -- Set once the per-job log budget was exhausted (one notice event is stored then).
  log_limited boolean NOT NULL DEFAULT false,
  -- Retention: when the job's rows were last purged (the head stays; stream sequences are never reused).
  purged_at   timestamptz NULL
);

CREATE TABLE job_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id      uuid NOT NULL REFERENCES jobs (id),
  attempt_id  uuid NOT NULL,
  attempt_no  integer NOT NULL CHECK (attempt_no >= 0),
  epoch       integer NOT NULL CHECK (epoch >= 0),
  worker_id   text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- The worker's outbox seq of the message (canonical order within an attempt); 0 for master notices.
  worker_seq  bigint NOT NULL CHECK (worker_seq >= 0),
  message_id  uuid NOT NULL,
  stream_seq  bigint NOT NULL CHECK (stream_seq >= 1),
  -- AgentEvent kinds, `artifact` (ARTIFACT_REF metadata) and `notice` (master markers).
  kind        text NOT NULL CHECK (kind IN ('status', 'message', 'tool_call', 'tool_result',
                'approval_request', 'usage', 'error', 'memory', 'artifact', 'notice')),
  -- Redacted payload (untrusted text: rendered escaped, never interpreted).
  payload     jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  ts          timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  size_bytes  integer NOT NULL CHECK (size_bytes >= 0),
  UNIQUE (job_id, message_id),
  UNIQUE (job_id, stream_seq)
);
CREATE INDEX job_events_order_idx ON job_events (job_id, attempt_no, worker_seq, id);
CREATE INDEX job_events_kind_idx ON job_events (job_id, kind, stream_seq);

CREATE TABLE job_log_chunks (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id      uuid NOT NULL REFERENCES jobs (id),
  attempt_id  uuid NOT NULL,
  attempt_no  integer NOT NULL CHECK (attempt_no >= 0),
  epoch       integer NOT NULL CHECK (epoch >= 0),
  worker_id   text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  worker_seq  bigint NOT NULL CHECK (worker_seq >= 1),
  message_id  uuid NOT NULL,
  stream      text NOT NULL CHECK (stream IN ('stdout', 'stderr', 'runtime')),
  chunk_seq   bigint NOT NULL CHECK (chunk_seq >= 0),
  stream_seq  bigint NOT NULL CHECK (stream_seq >= 1),
  ts          timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  -- Redacted text (worker exact-value + stream redaction, then the master pattern pass).
  text        text NOT NULL CHECK (length(text) <= 131072),
  size_bytes  integer NOT NULL CHECK (size_bytes >= 0),
  -- A chunk re-sent under a new message id (worker restart) is the same chunk.
  UNIQUE (attempt_id, stream, chunk_seq),
  UNIQUE (job_id, message_id),
  UNIQUE (job_id, stream_seq)
);
CREATE INDEX job_log_chunks_order_idx ON job_log_chunks (job_id, attempt_no, worker_seq, chunk_seq);
-- Free-text search over redacted text (pg_trgm from 0008).
CREATE INDEX job_log_chunks_text_trgm_idx ON job_log_chunks USING gin (text gin_trgm_ops);
