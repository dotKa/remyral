-- p5-ops-chat (ADR-0018, docs/design/p5-ops-chat.md): ChatGPT-style threads about the fleet, projects and jobs.
-- The assistant model runs on a worker chosen in Settings → Chat (never on the master); tools are served by the
-- master with the requesting user's authorization; writes only produce draft cards a human confirms.
-- Rows are written only through src/chat/*.
--
-- Not stored here, by design: model credentials (the worker's own runtime auth), streamed deltas (in memory
-- while a turn runs), tool inputs beyond ids and short summaries (the audit log keeps who called which tool).

-- Singleton: the kill switch, the assistant worker / runtime / model profile, limits (the "Chat" budget line).
CREATE TABLE chat_settings (
  id             smallint PRIMARY KEY CHECK (id = 1),
  enabled        boolean NOT NULL,
  worker_id      text NULL REFERENCES workers (id) ON DELETE SET NULL,
  runtime        text NOT NULL CHECK (runtime IN ('claude-code')),
  model_profile  text NULL CHECK (model_profile IS NULL OR model_profile ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  limits         jsonb NOT NULL CHECK (jsonb_typeof(limits) = 'object'),
  version        integer NOT NULL CHECK (version >= 1),
  updated_by     uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL
);
INSERT INTO chat_settings (id, enabled, runtime, limits, version, updated_at)
VALUES (1, false, 'claude-code', '{}', 1, now());

-- Threads are per user and private: every route checks user_id; nobody else (not even an owner) reads them.
CREATE TABLE chat_threads (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  archived_at      timestamptz NULL,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  next_seq         integer NOT NULL DEFAULT 1 CHECK (next_seq >= 1)
);
CREATE INDEX chat_threads_user ON chat_threads (user_id, updated_at DESC);

CREATE TABLE chat_messages (
  id          uuid PRIMARY KEY,
  thread_id   uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  seq         integer NOT NULL CHECK (seq >= 1),
  role        text NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'error')),
  -- user: the text as typed; assistant: Markdown (redacted); tool: a one-line summary; error: a public message.
  content     text NOT NULL CHECK (length(content) <= 262144),
  -- tool messages: {name, isError, draftId?} (no inputs beyond ids, no results).
  meta        jsonb NULL CHECK (meta IS NULL OR jsonb_typeof(meta) = 'object'),
  turn_id     uuid NULL,
  created_at  timestamptz NOT NULL,
  UNIQUE (thread_id, seq)
);

-- One row per assistant turn: who, where, outcome and usage (the Chat budget line). Kept when a thread is
-- deleted (accounting), without content.
CREATE TABLE chat_turns (
  id                  uuid PRIMARY KEY,
  thread_id           uuid NULL REFERENCES chat_threads (id) ON DELETE SET NULL,
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  worker_id           text NOT NULL,
  runtime             text NOT NULL,
  model               text NULL,
  state               text NOT NULL CHECK (state IN ('sent', 'running', 'done', 'failed', 'cancelled')),
  reason              text NULL CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,64}$'),
  tool_calls          integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  input_tokens        bigint NULL CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens       bigint NULL CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens   bigint NULL CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens  bigint NULL CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  cost_usd            numeric(20, 9) NULL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  provenance          text NULL CHECK (provenance IS NULL OR provenance IN ('reported-by-runtime', 'estimated-from-tokens', 'unknown')),
  auth_mode           text NULL CHECK (auth_mode IS NULL OR auth_mode IN ('secret-ref', 'local-login')),
  created_at          timestamptz NOT NULL,
  finished_at         timestamptz NULL
);
CREATE INDEX chat_turns_user ON chat_turns (user_id, created_at);
CREATE INDEX chat_turns_created ON chat_turns (created_at);
CREATE INDEX chat_turns_open ON chat_turns (state) WHERE state IN ('sent', 'running');

-- Draft cards: proposed by a write tool, confirmed (or dismissed) by the thread's owner in the console. The
-- payload is immutable after creation (payload_hash); confirming runs the normal service path with step-up.
CREATE TABLE chat_drafts (
  id            uuid PRIMARY KEY,
  thread_id     uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  turn_id       uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('job', 'workflow_run', 'worker_config', 'approval_decision', 'job_message')),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  payload       jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_hash  text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  -- The project the draft acts in (authorization on confirm), null for global targets (worker config).
  project       text NULL,
  state         text NOT NULL CHECK (state IN ('proposed', 'confirmed', 'dismissed', 'failed', 'expired')),
  result        jsonb NULL CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  created_at    timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  decided_at    timestamptz NULL
);
CREATE INDEX chat_drafts_thread ON chat_drafts (thread_id, created_at);

-- The worker's last CAPABILITIES.assistant report (engines, readiness, local opt-out).
ALTER TABLE workers
  ADD COLUMN assistant jsonb NULL CHECK (assistant IS NULL OR jsonb_typeof(assistant) = 'object'),
  ADD COLUMN assistant_at timestamptz NULL;
