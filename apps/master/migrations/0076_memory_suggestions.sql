-- p10-semantic-memory (docs/design/p10-semantic-memory.md): project memory suggestions and the embedding provider
-- state. Migration number 0076 (0075 was taken on main by backup notifications): renumber at merge if a parallel change took it.
--
-- Suggestions are proposals only: nothing here is ever part of a job's context bundle. An accepted suggestion becomes
-- an ordinary `memory` document in the project's context namespace through ContextStore.create (provenance `import`,
-- source naming the suggestion and its job), and only then reaches future jobs through the existing bundle mechanism.

---------------------------------------------------------------------------------------------------
-- The vector space the search index was last built with: a change of provider/model is audited once and the
-- indexer rebuilds every consented namespace (the reindex it triggers).
---------------------------------------------------------------------------------------------------

CREATE TABLE search_provider_state (
  name        text PRIMARY KEY CHECK (name = 'active'),
  model       text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  changed_at  timestamptz NOT NULL
);

---------------------------------------------------------------------------------------------------
-- Per-project opt-in (admin+, step-up, audited). No row = off.
--   rules    = the deterministic extraction pass over finished jobs
--   assisted = rules + the "Summarise with an agent" action (an ordinary job the user reviews and submits)
---------------------------------------------------------------------------------------------------

CREATE TABLE memory_suggestion_settings (
  project     text PRIMARY KEY CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  mode        text NOT NULL CHECK (mode IN ('off', 'rules', 'assisted')),
  version     integer NOT NULL CHECK (version >= 1),
  -- When the project last switched from off to on. Jobs that finished earlier are only read by a backfill.
  enabled_at  timestamptz NULL,
  updated_at  timestamptz NOT NULL,
  updated_by  uuid NULL REFERENCES users (id),
  CHECK (mode = 'off' OR enabled_at IS NOT NULL)
);

---------------------------------------------------------------------------------------------------
-- The inbox. One row per distinct learning per project: the fingerprint (sha256 of the normalised text) is unique,
-- so a dismissed suggestion is never proposed again and two jobs finding the same thing yield one row.
---------------------------------------------------------------------------------------------------

CREATE TABLE memory_suggestions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project            text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  state              text NOT NULL CHECK (state IN ('pending', 'accepted', 'dismissed')),
  -- job: rules over a finished job; agent_summary: the MEMORY: lines of a "Summarise with an agent" job;
  -- chat: proposed by the ops assistant on the user's request (suggest_memory tool).
  source             text NOT NULL CHECK (source IN ('job', 'agent_summary', 'chat')),
  job_id             uuid NULL REFERENCES jobs (id) ON DELETE CASCADE,
  thread_id          uuid NULL REFERENCES chat_threads (id) ON DELETE SET NULL,
  -- Which extraction rule produced it (package-manager, marker, color, deploy-note, command, chat …).
  rule               text NOT NULL CHECK (rule ~ '^[a-z][a-z0-9_-]{0,39}$'),
  title              text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  content            text NOT NULL CHECK (length(content) BETWEEN 1 AND 1000),
  fingerprint        text NOT NULL CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  -- The most similar existing memory/document when it was proposed (below the duplicate threshold).
  similar_doc_id     uuid NULL REFERENCES context_documents (id) ON DELETE SET NULL,
  similarity         real NULL CHECK (similarity IS NULL OR similarity BETWEEN -1 AND 1),
  similarity_method  text NULL CHECK (similarity_method IN ('semantic', 'lexical')),
  created_by         uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL,
  decided_at         timestamptz NULL,
  decided_by         uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  accepted_doc_id    uuid NULL REFERENCES context_documents (id) ON DELETE SET NULL,
  CHECK ((state = 'pending') = (decided_at IS NULL)),
  CHECK (source = 'chat' OR job_id IS NOT NULL OR state <> 'pending'),
  CHECK (accepted_doc_id IS NULL OR state = 'accepted')
);

CREATE UNIQUE INDEX memory_suggestions_fingerprint ON memory_suggestions (project, fingerprint);
CREATE INDEX memory_suggestions_inbox ON memory_suggestions (project, created_at DESC) WHERE state = 'pending';
CREATE INDEX memory_suggestions_job ON memory_suggestions (job_id) WHERE job_id IS NOT NULL;

---------------------------------------------------------------------------------------------------
-- Jobs the extraction pass has read (idempotent: a job is read once; a backfill skips them).
---------------------------------------------------------------------------------------------------

CREATE TABLE memory_suggestion_jobs (
  job_id           uuid PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  project          text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  processed_at     timestamptz NOT NULL,
  proposed         integer NOT NULL CHECK (proposed >= 0),
  duplicates       integer NOT NULL CHECK (duplicates >= 0),
  skipped_secrets  integer NOT NULL CHECK (skipped_secrets >= 0)
);
