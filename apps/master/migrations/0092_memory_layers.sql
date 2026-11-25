-- p11-memory-layers (docs/design/p11-memory-layers.md, ADR-0043): typed memory records on top of context documents.
-- Migration number 0092 (parallel: 0090 p11-fixes-a, 0091 p11-session-continuity, 0093 p11-runtime-advice; renumber
-- at merge if taken). Additive only: existing documents, bundles and pinned deliveries are unchanged.
--
-- A record IS a context document (immutable versions, per-job pinning, bundle hash); this migration adds its typed
-- metadata (type, scope, status, supersedes, review-by, evidence …), an append-only event history, conflict
-- suggestions ("this may replace X"), the `user:<id>` namespace for personal rules, and typed agent proposals in the
-- memory suggestions inbox.

---------------------------------------------------------------------------------------------------
-- user:<uuid> namespaces (a person's own rules; instructions only, readable and writable by that person alone).
---------------------------------------------------------------------------------------------------

ALTER TABLE context_documents DROP CONSTRAINT context_documents_namespace_check;
ALTER TABLE context_documents ADD CONSTRAINT context_documents_namespace_check
  CHECK (namespace = 'global' OR namespace ~ '^project:[A-Za-z0-9_.:-]{1,128}$'
         OR namespace ~ '^skill:[a-z0-9]+(-[a-z0-9]+)*$' AND length(namespace) <= 70
         OR namespace ~ '^machine:[A-Za-z0-9_.:-]{1,128}$'
         OR namespace ~ '^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE context_documents ADD CONSTRAINT context_documents_user_shape
  CHECK (namespace NOT LIKE 'user:%' OR (kind = 'instructions' AND project_scope = 'own'));
ALTER TABLE context_deletion_receipts DROP CONSTRAINT context_deletion_receipts_namespace_check;
ALTER TABLE context_deletion_receipts ADD CONSTRAINT context_deletion_receipts_namespace_check
  CHECK (namespace = 'global' OR namespace ~ '^project:[A-Za-z0-9_.:-]{1,128}$'
         OR namespace ~ '^skill:[a-z0-9]+(-[a-z0-9]+)*$' AND length(namespace) <= 70
         OR namespace ~ '^machine:[A-Za-z0-9_.:-]{1,128}$'
         OR namespace ~ '^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

---------------------------------------------------------------------------------------------------
-- Typed metadata of a record (1:1 with its context document). The statement text lives in the document's versions;
-- `statement`, `rationale` and `consequences` here are the editable fields of the CURRENT version.
---------------------------------------------------------------------------------------------------

CREATE TABLE memory_records (
  doc_id            uuid PRIMARY KEY REFERENCES context_documents (id) ON DELETE CASCADE,
  type              text NOT NULL CHECK (type IN ('rule', 'fact', 'decision', 'lesson')),
  -- global | runtime:<r> | user:<uuid> | project:<id> | project:<id>+runtime:<r>
  scope             text NOT NULL CHECK (length(scope) BETWEEN 6 AND 200),
  -- The project of a project scope (NULL for global / runtime / user scopes): listing and authorization.
  project           text NULL CHECK (project IS NULL OR project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  runtime           text NULL CHECK (runtime IS NULL OR runtime IN ('claude-code', 'codex', 'pi', 'opencode')),
  owner_user        uuid NULL REFERENCES users (id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'expired', 'rejected')),
  statement         text NOT NULL CHECK (length(statement) BETWEEN 1 AND 2000),
  rationale         text NULL CHECK (rationale IS NULL OR length(rationale) <= 2000),
  consequences      text NULL CHECK (consequences IS NULL OR length(consequences) <= 2000),
  decided_on        date NULL,
  decided_by        text NULL CHECK (decided_by IS NULL OR length(decided_by) <= 120),
  -- [{kind: job|chat|adr|doc|url, ref, label?}]
  evidence          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  author            text NOT NULL CHECK (author IN ('human', 'agent', 'runtime')),
  -- Human: the user id; agent / runtime: the job id the proposal came from (accepted by `accepted_by`).
  author_ref        text NULL CHECK (author_ref IS NULL OR length(author_ref) <= 200),
  accepted_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  suggestion_id     uuid NULL REFERENCES memory_suggestions (id) ON DELETE SET NULL,
  confidence        real NULL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  tags              text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 10),
  review_by         date NULL,
  review_notified   date NULL,
  expires_at        timestamptz NULL,
  supersedes        uuid NULL REFERENCES memory_records (doc_id) ON DELETE SET NULL,
  superseded_by     uuid NULL REFERENCES memory_records (doc_id) ON DELETE SET NULL,
  status_reason     text NULL CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  status_changed_at timestamptz NULL,
  status_changed_by uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  CHECK (type = 'decision' OR (consequences IS NULL AND decided_on IS NULL AND decided_by IS NULL)),
  CHECK (scope NOT LIKE 'user:%' OR (type = 'rule' AND owner_user IS NOT NULL)),
  CHECK ((scope LIKE 'project:%') = (project IS NOT NULL)),
  CHECK (status <> 'superseded' OR superseded_by IS NOT NULL),
  CHECK (supersedes IS NULL OR supersedes <> doc_id),
  CHECK (superseded_by IS NULL OR superseded_by <> doc_id)
);

CREATE INDEX memory_records_project ON memory_records (project, type, status) WHERE project IS NOT NULL;
CREATE INDEX memory_records_scope ON memory_records (scope, type, status);
CREATE INDEX memory_records_owner ON memory_records (owner_user) WHERE owner_user IS NOT NULL;
CREATE INDEX memory_records_review ON memory_records (review_by) WHERE status = 'active' AND review_by IS NOT NULL;
CREATE INDEX memory_records_expiry ON memory_records (expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;

---------------------------------------------------------------------------------------------------
-- History of a record's lifecycle (created, edited, superseded, expired, rejected, reactivated, review). Append-only.
---------------------------------------------------------------------------------------------------

CREATE TABLE memory_record_events (
  id           bigserial PRIMARY KEY,
  doc_id       uuid NOT NULL REFERENCES memory_records (doc_id) ON DELETE CASCADE,
  at           timestamptz NOT NULL,
  action       text NOT NULL CHECK (action IN ('created', 'edited', 'superseded', 'supersedes', 'expired',
                                               'rejected', 'reactivated', 'review_due', 'reviewed', 'typed')),
  actor_type   text NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_id     text NULL CHECK (actor_id IS NULL OR length(actor_id) <= 200),
  version      integer NULL CHECK (version IS NULL OR version >= 1),
  related_id   uuid NULL,
  note         text NULL CHECK (note IS NULL OR length(note) <= 500)
);
CREATE INDEX memory_record_events_doc ON memory_record_events (doc_id, id);

CREATE FUNCTION memory_record_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('remana.context_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'memory_record_events is append-only (% rejected)', TG_OP USING ERRCODE = 'RA000';
END;
$$;
CREATE TRIGGER memory_record_events_no_update
  BEFORE UPDATE ON memory_record_events FOR EACH ROW EXECUTE FUNCTION memory_record_events_append_only();

---------------------------------------------------------------------------------------------------
-- "This may replace X": a new record that is very similar to (or contradicts) an active record of the same type and
-- project, waiting for a person (supersede, or keep both).
---------------------------------------------------------------------------------------------------

CREATE TABLE memory_record_conflicts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project      text NULL CHECK (project IS NULL OR project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  scope        text NOT NULL CHECK (length(scope) BETWEEN 6 AND 200),
  record_id    uuid NOT NULL REFERENCES memory_records (doc_id) ON DELETE CASCADE,
  other_id     uuid NOT NULL REFERENCES memory_records (doc_id) ON DELETE CASCADE,
  score        real NOT NULL CHECK (score BETWEEN -1 AND 1),
  method       text NOT NULL CHECK (method IN ('semantic', 'lexical')),
  reason       text NOT NULL CHECK (reason IN ('similar', 'negation', 'different_choice', 'different_value')),
  state        text NOT NULL CHECK (state IN ('pending', 'superseded', 'kept')),
  created_at   timestamptz NOT NULL,
  decided_at   timestamptz NULL,
  decided_by   uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  CHECK (record_id <> other_id),
  CHECK ((state = 'pending') = (decided_at IS NULL)),
  UNIQUE (record_id, other_id)
);
CREATE INDEX memory_record_conflicts_pending ON memory_record_conflicts (project, created_at DESC) WHERE state = 'pending';

---------------------------------------------------------------------------------------------------
-- Memory suggestions become typed: what the accepted record will be, the runtime of a lesson, the record it may
-- replace, and agent proposals (LESSON: / MEMORY: lines of a runtime's own output, and `memory` events).
---------------------------------------------------------------------------------------------------

ALTER TABLE memory_suggestions DROP CONSTRAINT memory_suggestions_source_check;
ALTER TABLE memory_suggestions ADD CONSTRAINT memory_suggestions_source_check
  CHECK (source IN ('job', 'agent_summary', 'chat', 'agent'));
ALTER TABLE memory_suggestions
  ADD COLUMN record_type text NULL CHECK (record_type IS NULL OR record_type IN ('rule', 'fact', 'decision', 'lesson')),
  ADD COLUMN runtime text NULL CHECK (runtime IS NULL OR runtime IN ('claude-code', 'codex', 'pi', 'opencode')),
  ADD COLUMN attempt_id uuid NULL,
  -- The active record this suggestion may replace (similar + contradiction, or very similar of the same type).
  ADD COLUMN replaces_doc_id uuid NULL REFERENCES context_documents (id) ON DELETE SET NULL,
  ADD COLUMN replaces_reason text NULL
    CHECK (replaces_reason IS NULL OR replaces_reason IN ('similar', 'negation', 'different_choice', 'different_value')),
  ADD CONSTRAINT memory_suggestions_agent_shape CHECK (source <> 'agent' OR job_id IS NOT NULL OR state <> 'pending');
CREATE INDEX memory_suggestions_agent_job ON memory_suggestions (job_id, created_at) WHERE source = 'agent';

---------------------------------------------------------------------------------------------------
-- Notification kind: a record's review-by date has come (once per record and date). Appended to whatever the
-- constraints allow now (other migrations of the same release may add kinds too).
---------------------------------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  c text;
  def text;
  kinds text[];
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_preferences'] LOOP
    c := t || '_kind_check';
    SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
     WHERE conname = c AND conrelid = t::regclass;
    IF def IS NULL THEN
      RAISE EXCEPTION 'constraint % not found', c;
    END IF;
    -- Either ARRAY['a'::text, …] (an IN list) or '{a,b,…}'::text[] (written by an earlier migration like this one).
    IF def ~ '\{' THEN
      kinds := string_to_array(substring(def from '\{([^}]*)\}'), ',');
    ELSE
      SELECT array_agg(DISTINCT m[1]) INTO kinds FROM regexp_matches(def, '''([a-z0-9_.]+)''', 'g') AS m;
    END IF;
    IF coalesce(array_length(kinds, 1), 0) < 2 THEN
      RAISE EXCEPTION 'could not read the kinds of %', c;
    END IF;
    kinds := kinds || ARRAY['memory.review_due'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, c, kinds);
  END LOOP;
END;
$$;

---------------------------------------------------------------------------------------------------
-- Chat draft kind `memory_change` (the assistant drafts a memory change; the user confirms it). Appended to the
-- current list for the same reason.
---------------------------------------------------------------------------------------------------

DO $$
DECLARE
  def text;
  kinds text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'chat_drafts_kind_check' AND conrelid = 'chat_drafts'::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint chat_drafts_kind_check not found';
  END IF;
  IF def ~ '\{' THEN
    kinds := string_to_array(substring(def from '\{([^}]*)\}'), ',');
  ELSE
    SELECT array_agg(DISTINCT m[1]) INTO kinds FROM regexp_matches(def, '''([a-z0-9_]+)''', 'g') AS m;
  END IF;
  IF coalesce(array_length(kinds, 1), 0) < 2 THEN
    RAISE EXCEPTION 'could not read the kinds of chat_drafts_kind_check';
  END IF;
  kinds := kinds || ARRAY['memory_change'];
  SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
  ALTER TABLE chat_drafts DROP CONSTRAINT chat_drafts_kind_check;
  EXECUTE format('ALTER TABLE chat_drafts ADD CONSTRAINT chat_drafts_kind_check CHECK (kind = ANY (%L::text[]))', kinds);
END;
$$;
