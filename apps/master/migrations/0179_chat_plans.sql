-- p18-plan-mode (docs/design/p18-plan-mode.md §5): plan mode and the plan (roadmap) of a Sohbet conversation.
--
--  * chat_plans          one plan of a conversation: title, goal, meta (assumptions, risks), state, version (structural
--                        changes), rev (every change; the console's optimistic base), the approved version, and the
--                        continuation bookkeeping of an executing plan (W2: due, stalled reason, last turn, progress mark).
--                        One ACTIVE plan per conversation (partial unique index); older ones stay as history.
--  * chat_plan_items     the items (stable key per plan, phase, position, status, owner, project, dependencies, links).
--  * chat_plan_versions  a snapshot per structural version (≤ 50 kept per plan, the service prunes).
--  * chat_threads.plan_mode_since   plan mode is a conversation state (survives reload, every device).
--  * user_questions.plan_id / plan_item_key   plan decisions are question rows keyed by plan (one source of truth).
--
-- Additive. An older master ignores the tables and columns. Rollback:
--   ALTER TABLE user_questions DROP COLUMN plan_item_key, DROP COLUMN plan_id;
--   ALTER TABLE chat_threads DROP COLUMN plan_mode_since;
--   DROP TABLE chat_plan_versions, chat_plan_items, chat_plans;

CREATE TABLE chat_plans (
  id               uuid PRIMARY KEY,
  thread_id        uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title            text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  goal             text NOT NULL CHECK (char_length(goal) BETWEEN 1 AND 1000),
  meta             jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(meta) = 'object' AND octet_length(meta::text) <= 16384),
  state            text NOT NULL CHECK (state IN ('drafting', 'in_review', 'approved', 'executing', 'paused', 'done',
                                                  'cancelled', 'superseded')),
  version          integer NOT NULL CHECK (version >= 1),
  rev              bigint NOT NULL CHECK (rev >= 1),
  approved_version integer NULL CHECK (approved_version IS NULL OR approved_version >= 1),
  created_turn     uuid NULL,
  -- W2 continuation: a blocker resolved and the assistant should go on (`cont_due`), why it cannot right now
  -- (`stalled`: cost_brake / budget / no_progress), the last continuation turn and the progress mark it started from.
  cont_due         boolean NOT NULL DEFAULT false,
  stalled          text NULL CHECK (stalled IS NULL OR stalled ~ '^[a-z_]{1,32}$'),
  cont_turn        uuid NULL,
  cont_mark        text NULL CHECK (cont_mark IS NULL OR char_length(cont_mark) <= 128),
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  closed_at        timestamptz NULL
);
CREATE UNIQUE INDEX chat_plans_active_idx ON chat_plans (thread_id)
  WHERE state IN ('drafting', 'in_review', 'approved', 'executing', 'paused');
CREATE INDEX chat_plans_thread_idx ON chat_plans (thread_id, created_at DESC);
CREATE INDEX chat_plans_executing_idx ON chat_plans (updated_at) WHERE state IN ('executing', 'approved');

CREATE TABLE chat_plan_items (
  id            uuid PRIMARY KEY,
  plan_id       uuid NOT NULL REFERENCES chat_plans (id) ON DELETE CASCADE,
  key           text NOT NULL CHECK (key ~ '^[a-z0-9-]{1,32}$'),
  phase         smallint NOT NULL CHECK (phase BETWEEN 0 AND 7),
  phase_title   text NOT NULL CHECK (char_length(phase_title) BETWEEN 1 AND 80),
  position      integer NOT NULL CHECK (position >= 0),
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 140),
  active_title  text NULL CHECK (active_title IS NULL OR char_length(active_title) BETWEEN 1 AND 140),
  detail        text NULL CHECK (detail IS NULL OR char_length(detail) <= 1000),
  status        text NOT NULL CHECK (status IN ('pending', 'in_progress', 'done', 'blocked', 'skipped')),
  owner         text NOT NULL CHECK (owner IN ('assistant', 'user', 'job', 'workflow')),
  project       text NULL CHECK (project IS NULL OR project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  depends_on    text[] NOT NULL DEFAULT '{}' CHECK (cardinality(depends_on) <= 5),
  estimate      jsonb NULL CHECK (estimate IS NULL OR jsonb_typeof(estimate) IN ('string', 'number')),
  links         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(links) = 'array' AND octet_length(links::text) <= 8192),
  note          text NULL CHECK (note IS NULL OR char_length(note) <= 300),
  -- Who set the status last: the assistant / the person, or `derived` from a linked draft, job or run.
  status_by     text NOT NULL DEFAULT 'assistant' CHECK (status_by IN ('assistant', 'user', 'derived')),
  deleted_at    timestamptz NULL,
  updated_at    timestamptz NOT NULL,
  UNIQUE (plan_id, key)
);
CREATE INDEX chat_plan_items_plan_idx ON chat_plan_items (plan_id, phase, position) WHERE deleted_at IS NULL;

CREATE TABLE chat_plan_versions (
  plan_id     uuid NOT NULL REFERENCES chat_plans (id) ON DELETE CASCADE,
  version     integer NOT NULL CHECK (version >= 1),
  author      text NOT NULL CHECK (author IN ('assistant', 'user')),
  reason      text NULL CHECK (reason IS NULL OR char_length(reason) <= 300),
  snapshot    jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 65536),
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (plan_id, version)
);

ALTER TABLE chat_threads ADD COLUMN plan_mode_since timestamptz NULL;

ALTER TABLE user_questions
  ADD COLUMN plan_id uuid NULL REFERENCES chat_plans (id) ON DELETE CASCADE,
  ADD COLUMN plan_item_key text NULL CHECK (plan_item_key IS NULL OR plan_item_key ~ '^[a-z0-9-]{1,32}$');
CREATE INDEX user_questions_plan_idx ON user_questions (plan_id, created_at) WHERE plan_id IS NOT NULL;
