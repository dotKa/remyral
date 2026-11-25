-- p10-semantic-defaults-chat (docs/design/p10-semantic-memory.md §12): project knowledge on by default, chat in the
-- embeddings. Migration number 0081 (0080 = p10-chat-organize; renumber at merge if a parallel change took it).
--
-- 1. A platform default for new projects (search capture on, memory suggestions `rules`) and where each project's
--    current setting came from (`explicit` = an admin changed it, `create` = chosen in the create-project form,
--    `platform_default` = applied by the one-time backfill for a project that never made a choice). Existing rows are
--    explicit choices: an explicit "off" stays off. The backfill itself runs in the master (it writes one audit entry
--    per project through the hash-chained audit log, which plain SQL cannot), once, recorded in `backfilled_at`.
-- 2. Ops chat messages (user messages, assistant answers, small text attachments) as vectors: per user (only the
--    thread's owner can ever search them) and — for messages linked deterministically to a project (thread project,
--    @project mention, a draft for that project in the same turn) — in that project, unless the owner switched the
--    sharing off (per thread or per user) or the project's capture is off. Like search_embeddings, only vectors are
--    stored, never text: snippets are read from the live messages at query time. Chat vectors never reach a job's
--    context bundle (the bundle reads context documents only).

---------------------------------------------------------------------------------------------------
-- Platform defaults (one row).
---------------------------------------------------------------------------------------------------

CREATE TABLE semantic_defaults (
  id               smallint PRIMARY KEY CHECK (id = 1),
  -- New projects: search capture (context documents, job summaries, project-linked chat) on or off.
  project_capture  boolean NOT NULL,
  -- New projects: memory suggestion mode.
  memory_mode      text NOT NULL CHECK (memory_mode IN ('off', 'rules', 'assisted')),
  version          integer NOT NULL CHECK (version >= 1),
  updated_at       timestamptz NOT NULL,
  updated_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  -- When the one-time backfill of existing projects ran (NULL: not yet).
  backfilled_at    timestamptz NULL
);
INSERT INTO semantic_defaults (id, project_capture, memory_mode, version, updated_at)
VALUES (1, true, 'rules', 1, now());

ALTER TABLE search_consent
  ADD COLUMN source text NOT NULL DEFAULT 'explicit'
    CHECK (source IN ('explicit', 'create', 'platform_default'));
ALTER TABLE memory_suggestion_settings
  ADD COLUMN source text NOT NULL DEFAULT 'explicit'
    CHECK (source IN ('explicit', 'create', 'platform_default'));

---------------------------------------------------------------------------------------------------
-- Chat: the thread's project (set in the chat header) and the owner's per-thread sharing switch.
-- `links_synced_at` / `search_synced_at`: the indexer's marks (NULL or older than updated_at: the thread's project
-- links / vectors need a pass; vectors need a provider, links do not).
---------------------------------------------------------------------------------------------------

ALTER TABLE chat_threads
  ADD COLUMN project text NULL CHECK (project IS NULL OR project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  ADD COLUMN project_share boolean NOT NULL DEFAULT true,
  ADD COLUMN links_synced_at timestamptz NULL,
  ADD COLUMN search_synced_at timestamptz NULL;
CREATE INDEX chat_threads_project_idx ON chat_threads (project) WHERE project IS NOT NULL;

-- Per-user chat knowledge preferences. No row = every switch on (the platform default).
CREATE TABLE chat_search_prefs (
  user_id         uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- Index my conversations at all (off: every chat vector of the user is deleted, user and project scope).
  index_enabled   boolean NOT NULL,
  -- Share project-related chat with project knowledge (off: the user's project-scope vectors are deleted).
  share_projects  boolean NOT NULL,
  -- Look up related knowledge automatically on every message I send.
  auto_related    boolean NOT NULL,
  version         integer NOT NULL CHECK (version >= 1),
  updated_at      timestamptz NOT NULL
);

-- Which projects a message is linked to, and why (recomputed by the indexer per thread, deterministic, no model).
CREATE TABLE chat_message_links (
  message_id  uuid NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
  thread_id   uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  project     text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- thread: the thread's project; mention: an @project mention in the turn's message; draft: a draft card for the
  -- project in the same turn.
  reason      text NOT NULL CHECK (reason IN ('thread', 'mention', 'draft')),
  PRIMARY KEY (message_id, project)
);
CREATE INDEX chat_message_links_project_idx ON chat_message_links (project);
CREATE INDEX chat_message_links_thread_idx ON chat_message_links (thread_id);

CREATE TABLE chat_embeddings (
  id              bigserial PRIMARY KEY,
  -- user: searchable only by the thread's owner; project: by readers of `project`.
  scope           text NOT NULL CHECK (scope IN ('user', 'project')),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  thread_id       uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  message_id      uuid NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
  -- A small text attachment of the message (NULL: the message text).
  attachment_id   uuid NULL REFERENCES chat_attachments (id) ON DELETE CASCADE,
  seq             integer NOT NULL CHECK (seq >= 1),
  author          text NOT NULL CHECK (author IN ('user', 'assistant')),
  chunk           smallint NOT NULL CHECK (chunk BETWEEN 0 AND 63),
  project         text NULL CHECK (project IS NULL OR project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- sha256 of the exact (redacted) text that was embedded — never the text itself.
  content_hash    text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  model           text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  dims            integer NOT NULL CHECK (dims BETWEEN 1 AND 8192),
  embedding       real[] NOT NULL CHECK (cardinality(embedding) = dims AND array_ndims(embedding) = 1),
  indexed_at      timestamptz NOT NULL,
  CHECK ((scope = 'project') = (project IS NOT NULL))
);
CREATE UNIQUE INDEX chat_embeddings_key ON chat_embeddings
  (message_id, coalesce(attachment_id, '00000000-0000-0000-0000-000000000000'::uuid), chunk, scope,
   coalesce(project, ''));
CREATE INDEX chat_embeddings_user_idx ON chat_embeddings (user_id, model) WHERE scope = 'user';
CREATE INDEX chat_embeddings_project_idx ON chat_embeddings (project, model) WHERE scope = 'project';
CREATE INDEX chat_embeddings_thread_idx ON chat_embeddings (thread_id);
