-- p10-chat-organize (docs/design/p10-chat-organize.md): the caller's own organisation of the ops chat — pinned
-- conversations, user-defined groups (a conversation is in at most one), coloured tags (several per conversation) and
-- starred messages. Everything is per user and keyed by (thread, user) like chat_thread_reads, so it stays private if
-- threads are ever shared. Rows are written only through src/chat/organize.ts. Migration number 0080: renumber at merge
-- if a parallel change took it.

CREATE TABLE chat_thread_pins (
  thread_id  uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  pinned_at  timestamptz NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX chat_thread_pins_user ON chat_thread_pins (user_id, pinned_at DESC);

CREATE TABLE chat_groups (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  position    integer NOT NULL CHECK (position BETWEEN 0 AND 100000),
  collapsed   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  -- Target of the composite foreign key below: a membership can only name a group of the same user.
  UNIQUE (user_id, id)
);
CREATE UNIQUE INDEX chat_groups_user_name ON chat_groups (user_id, lower(name));

-- At most one group per conversation and user (the primary key).
CREATE TABLE chat_thread_groups (
  thread_id  uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  group_id   uuid NOT NULL,
  added_at   timestamptz NOT NULL,
  PRIMARY KEY (thread_id, user_id),
  FOREIGN KEY (user_id, group_id) REFERENCES chat_groups (user_id, id) ON DELETE CASCADE
);
CREATE INDEX chat_thread_groups_group ON chat_thread_groups (group_id);

CREATE TABLE chat_tags (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  -- A closed palette (the console maps names to its theme tokens; never free CSS).
  color       text NOT NULL CHECK (color IN ('gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink')),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  UNIQUE (user_id, id)
);
CREATE UNIQUE INDEX chat_tags_user_name ON chat_tags (user_id, lower(name));

CREATE TABLE chat_thread_tags (
  thread_id  uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL,
  added_at   timestamptz NOT NULL,
  PRIMARY KEY (thread_id, tag_id),
  FOREIGN KEY (user_id, tag_id) REFERENCES chat_tags (user_id, id) ON DELETE CASCADE
);
CREATE INDEX chat_thread_tags_user_tag ON chat_thread_tags (user_id, tag_id);

-- Starred user / assistant messages (the role is checked by the service).
CREATE TABLE chat_message_stars (
  message_id  uuid NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  thread_id   uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  starred_at  timestamptz NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX chat_message_stars_user ON chat_message_stars (user_id, starred_at DESC);
CREATE INDEX chat_message_stars_thread ON chat_message_stars (thread_id, user_id);
