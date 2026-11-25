-- p2-replay (ADR-0004 §4, ADR-0011): resume cursors both ways, the master's durable per-worker outbox,
-- the bounded dedupe window of processed worker messages, and the inbox journal of sequenced worker
-- messages (p4 routes them into jobs). p2-identity-rotation: rotation nonce bookkeeping.
-- Design: docs/design/p2-transport.md.

ALTER TABLE workers
  -- Highest worker seq processed (contiguous); sent as SESSION_ESTABLISHED.resumeFromSeq.
  ADD COLUMN last_worker_seq  bigint NOT NULL DEFAULT 0 CHECK (last_worker_seq >= 0),
  -- Next seq the master assigns to a sequenced message for this worker.
  ADD COLUMN next_master_seq  bigint NOT NULL DEFAULT 1 CHECK (next_master_seq >= 1),
  -- Highest master seq the worker acknowledged; outbox rows ≤ it are deleted.
  ADD COLUMN acked_master_seq bigint NOT NULL DEFAULT 0 CHECK (acked_master_seq >= 0),
  -- Outstanding ROTATE_CREDENTIAL nonce (SHA-256) and its expiry (p2-identity-rotation).
  ADD COLUMN rotation_nonce_hash bytea NULL CHECK (rotation_nonce_hash IS NULL OR length(rotation_nonce_hash) = 32),
  ADD COLUMN rotation_expires_at timestamptz NULL,
  ADD COLUMN rotation_requested_by uuid NULL REFERENCES users (id) ON DELETE SET NULL;

-- Master → worker sequenced messages until the worker acknowledges them.
CREATE TABLE worker_outbox (
  worker_id   text NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  seq         bigint NOT NULL CHECK (seq >= 1),
  type        text NOT NULL CHECK (length(type) <= 64),
  job_id      text NULL CHECK (length(job_id) <= 128),
  payload     jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (worker_id, seq)
);

-- Bounded window of processed worker messages (idempotency by messageId; the seq cursor covers older ones).
CREATE TABLE worker_processed_messages (
  worker_id     text NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  message_id    uuid NOT NULL,
  seq           bigint NOT NULL CHECK (seq >= 1),
  processed_at  timestamptz NOT NULL,
  PRIMARY KEY (worker_id, message_id)
);
CREATE INDEX worker_processed_messages_seq_idx ON worker_processed_messages (worker_id, seq);

-- Journal of sequenced worker messages (LEASE_ACK, EVENT, LOG_CHUNK, JOB_RESULT, ARTIFACT_REF), exactly
-- once per (worker, seq). Validated envelopes; LOG_CHUNK data was redacted on the worker (ADR-0006).
CREATE TABLE worker_inbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  worker_id    text NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  seq          bigint NOT NULL CHECK (seq >= 1),
  message_id   uuid NOT NULL,
  type         text NOT NULL CHECK (length(type) <= 64),
  job_id       text NULL CHECK (length(job_id) <= 128),
  payload      jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  received_at  timestamptz NOT NULL,
  UNIQUE (worker_id, seq),
  UNIQUE (worker_id, message_id)
);
