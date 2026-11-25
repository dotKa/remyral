-- p15-message-delivery (docs/design/p15-message-delivery.md): every human message to a job's agent (panel message box,
-- Diyalog job thread, chat `draft_job_message`) with its delivery state, so "sent" is never just a 202:
--   waiting (held by the master until the agent runs) → sent (worker outbox) → received (worker ACK / receipt)
--   → delivered (runtime accepted it) → read (agent took it) | failed (code + detail).
-- Plus the chat assistant's "Otomatik" fallback account (p15 item 2): `fallback_account = 'auto'` (account ids are
-- `default` or 8 characters starting with `a`, so 'auto' is never an account id). Existing settings move to 'auto';
-- an explicit "Yok" stays NULL from now on.
-- Additive (rollback: leave the table; older code never reads it, and older code treats 'auto' as an unknown account
-- — no fallback, today's behaviour). Migration number 0121 (given in the brief); renumber at merge if needed.

CREATE TABLE job_messages (
  id              uuid PRIMARY KEY,
  job_id          uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  -- The browser's idempotency key (a retried POST is the same message).
  client_id       uuid NULL,
  source          text NOT NULL CHECK (source IN ('panel', 'chat')),
  sent_by         uuid NOT NULL REFERENCES users (id),
  text            text NOT NULL CHECK (length(text) BETWEEN 1 AND 8192),
  status          text NOT NULL CHECK (status IN ('waiting', 'sent', 'received', 'delivered', 'read', 'failed')),
  -- received: 'held' while the runtime starts; failed: why (job_not_running, run_ended, …).
  code            text NULL CHECK (code IS NULL OR code ~ '^[a-z][a-z0-9_]{0,63}$'),
  detail          text NULL CHECK (detail IS NULL OR length(detail) <= 500),
  -- Where it went (NULL while waiting).
  attempt_id      uuid NULL,
  epoch           integer NULL,
  worker_id       text NULL,
  outbox_seq      bigint NULL,
  -- The worker reports JOB_MESSAGE_STATUS for it (job-message-receipts-v1).
  receipts        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  UNIQUE (job_id, client_id)
);

CREATE INDEX job_messages_job_idx ON job_messages (job_id, created_at);
-- The outbox ACK marks queued messages received (one indexed lookup per ACK).
CREATE INDEX job_messages_unacked_idx ON job_messages (worker_id, outbox_seq) WHERE status = 'sent';
-- The tick: held messages to send and open messages of ended attempts.
CREATE INDEX job_messages_open_idx ON job_messages (status, updated_at)
  WHERE status IN ('waiting', 'sent', 'received');

UPDATE chat_settings SET fallback_account = 'auto' WHERE fallback_account IS NULL;
