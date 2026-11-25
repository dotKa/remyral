-- p6-chat-notify (docs/design/p6-chat-notify.md): the ops chat can tell its user later ("haber ver"). A watch
-- follows ONE resource the user can read (job, workflow run, automation, ops action, approval request, machine, or
-- a chat draft until it is confirmed) on a fixed set of conditions; when it fires, the master posts a note into the
-- originating thread and notifies the user (kind chat.watch) through the user's own enabled channels. The recipient
-- is always the watch's owner: there is no recipient column. Fired from an orchestrator tick step, DB-backed.

CREATE TABLE chat_watches (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The originating conversation (a deleted thread keeps the watch: the bell still tells).
  thread_id      uuid NULL REFERENCES chat_threads (id) ON DELETE SET NULL,
  turn_id        uuid NULL,
  target_kind    text NOT NULL CHECK (target_kind IN ('job', 'workflow_run', 'automation', 'ops_action', 'approval',
                                                       'worker', 'draft')),
  -- uuid targets (everything but machines) and machine ids.
  target_uuid    uuid NULL,
  target_ref     text NULL CHECK (target_ref IS NULL OR target_ref ~ '^wrk_[a-z2-7]{26}$'),
  CHECK ((target_kind = 'worker') = (target_ref IS NOT NULL)),
  CHECK ((target_kind = 'worker') = (target_uuid IS NULL)),
  -- The resource's project at creation / binding (listing; the authorization is re-checked when it fires).
  project        text NULL CHECK (project IS NULL OR project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  label          text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  conditions     text[] NOT NULL CHECK (cardinality(conditions) BETWEEN 1 AND 8
                   AND conditions <@ ARRAY['finished', 'succeeded', 'failed', 'cancelled', 'approval_requested',
                                           'decided', 'online', 'offline']::text[]),
  repeat         text NOT NULL CHECK (repeat IN ('once', 'every')),
  language       text NOT NULL CHECK (language IN ('tr', 'en')),
  state          text NOT NULL CHECK (state IN ('active', 'done', 'cancelled', 'expired', 'revoked')),
  end_reason     text NULL CHECK (end_reason IS NULL OR length(end_reason) <= 300),
  -- Per-kind progress (machines: last seen up/down and the number of flips).
  cursor         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(cursor) = 'object'),
  fire_count     integer NOT NULL DEFAULT 0 CHECK (fire_count >= 0),
  last_fired_at  timestamptz NULL,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL CHECK (expires_at > created_at),
  ended_at       timestamptz NULL,
  CHECK ((state = 'active') = (ended_at IS NULL))
);
CREATE INDEX chat_watches_active_idx ON chat_watches (target_kind, created_at) WHERE state = 'active';
CREATE INDEX chat_watches_user_idx ON chat_watches (user_id, created_at DESC);
CREATE INDEX chat_watches_thread_idx ON chat_watches (thread_id, created_at DESC) WHERE thread_id IS NOT NULL;
-- One active watch per user, thread and target (asking again updates it).
CREATE UNIQUE INDEX chat_watches_dedupe_idx ON chat_watches
  (user_id, COALESCE(thread_id, '00000000-0000-0000-0000-000000000000'::uuid), target_kind,
   COALESCE(target_uuid::text, target_ref))
  WHERE state = 'active';

-- Every occurrence a watch evaluated, delivered or not (dedupe across ticks, replicas and restarts).
CREATE TABLE chat_watch_fires (
  watch_id    uuid NOT NULL REFERENCES chat_watches (id) ON DELETE CASCADE,
  occurrence  text NOT NULL CHECK (occurrence ~ '^[a-z]+(:[A-Za-z0-9_-]{1,64})?$'),
  delivered   boolean NOT NULL,
  fired_at    timestamptz NOT NULL,
  PRIMARY KEY (watch_id, occurrence)
);

-- Console notifications: a chat watch fired; a note the user asked the assistant to send now.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed', 'deploy.succeeded', 'chat.watch', 'chat.note'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed', 'deploy.succeeded', 'chat.watch', 'chat.note'));
