-- p20-outcome (docs/design/p20-outcome-contract.md; owner 2026-10-31: "işler bu şekilde boşta kalmamalı. devam etmeli
-- ya da benim müdahalem gerekiyorsa müdahale etmeliyim"): one owner row per open goal of a conversation — a ledger over
-- the existing job / plan / watch / workflow run records (no scheduler). It ends in a result or in one persistent
-- intervention ("Senden bekleyen").
--
--  * chat_goals: the goal (source, outcome condition, next action, owner, coded blocked reason, reevaluate time, state).
--  * chat_goal_links: the records a goal owns; a record belongs to at most one goal.
--  * chat_goal_ledger: when the ledger started (records older than that are never adopted).
--
-- Additive. Rollback: an older master never reads the tables; to remove:
--   DROP TABLE chat_goal_links, chat_goals, chat_goal_ledger;

CREATE TABLE chat_goals (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  thread_id         uuid NULL REFERENCES chat_threads (id) ON DELETE SET NULL,
  origin_kind       text NOT NULL CHECK (origin_kind IN ('plan', 'job', 'workflow_run', 'watch')),
  origin_id         uuid NOT NULL,
  title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  outcome_condition text NOT NULL CHECK (char_length(outcome_condition) BETWEEN 1 AND 300),
  next_action       text NULL CHECK (next_action IS NULL OR next_action ~ '^[a-z_]{1,40}$'),
  next_note         text NULL CHECK (next_note IS NULL OR char_length(next_note) <= 300),
  owner             text NOT NULL CHECK (owner IN ('assistant', 'user', 'job', 'workflow', 'system')),
  blocked_reason    text NULL CHECK (blocked_reason IS NULL OR blocked_reason ~ '^[a-z_]{1,40}(:[a-z_]{1,40})?$'),
  reevaluate_at     timestamptz NULL,
  state             text NOT NULL CHECK (state IN ('open', 'done', 'intervention', 'cancelled')),
  detail            text NULL CHECK (detail IS NULL OR char_length(detail) <= 500),
  user_action       text NULL CHECK (user_action IS NULL OR char_length(user_action) <= 300),
  -- The assistant declared the current state itself (goal_update): the derived assessment does not overwrite it
  -- until one of the goal's records changes.
  declared          boolean NOT NULL DEFAULT false,
  episode           integer NOT NULL DEFAULT 0 CHECK (episode >= 0),
  notified_episode  integer NOT NULL DEFAULT 0 CHECK (notified_episode >= 0),
  interventions     integer NOT NULL DEFAULT 0 CHECK (interventions >= 0),
  follow_ups        integer NOT NULL DEFAULT 0 CHECK (follow_ups >= 0),
  resolved_by       text NULL CHECK (resolved_by IS NULL OR resolved_by IN ('outcome', 'assistant', 'user', 'cancel')),
  -- What the derived assessment last saw of the goal's records (a change lifts a declared state).
  fingerprint       text NULL CHECK (fingerprint IS NULL OR char_length(fingerprint) <= 2000),
  opened_at         timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  last_progress_at  timestamptz NOT NULL,
  intervention_at   timestamptz NULL,
  closed_at         timestamptz NULL,
  CHECK ((state IN ('done', 'cancelled')) = (closed_at IS NOT NULL)),
  UNIQUE (origin_kind, origin_id)
);
CREATE INDEX chat_goals_live_idx ON chat_goals (updated_at) WHERE state IN ('open', 'intervention');
CREATE INDEX chat_goals_user_idx ON chat_goals (user_id, state, updated_at DESC);
CREATE INDEX chat_goals_thread_idx ON chat_goals (thread_id, opened_at DESC) WHERE thread_id IS NOT NULL;

CREATE TABLE chat_goal_links (
  kind        text NOT NULL CHECK (kind IN ('plan', 'job', 'workflow_run', 'watch', 'draft')),
  ref_id      uuid NOT NULL,
  goal_id     uuid NOT NULL REFERENCES chat_goals (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (kind, ref_id)
);
CREATE INDEX chat_goal_links_goal_idx ON chat_goal_links (goal_id, created_at);

CREATE TABLE chat_goal_ledger (
  id     boolean PRIMARY KEY DEFAULT true CHECK (id),
  since  timestamptz NOT NULL
);
