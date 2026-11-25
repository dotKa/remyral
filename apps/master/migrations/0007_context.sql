-- p6-context-model (ADR-0010 §4 provenance, ADR-0006 no secrets, threat model T-INJ-5, T-SEC-1):
-- namespaced context documents with immutable versions, project grants and per-job bundle deliveries.
-- Rows are written only through src/context/store.ts (ContextStore). The triggers below are defence in
-- depth (SQLSTATE RA000 like 0003/0005). Design: docs/design/p6-context-model.md.

---------------------------------------------------------------------------------------------------
-- Documents: identity, access and the current-version pointer.
---------------------------------------------------------------------------------------------------

CREATE TABLE context_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace        text NOT NULL
                     CHECK (namespace = 'global' OR namespace ~ '^project:[A-Za-z0-9_.:-]{1,128}$'),
  kind             text NOT NULL CHECK (kind IN ('instructions', 'memory', 'reference')),
  read_role        text NOT NULL CHECK (read_role IN ('viewer', 'operator', 'admin', 'owner')),
  write_role       text NOT NULL CHECK (write_role IN ('operator', 'admin', 'owner')),
  -- own: project documents (their project only); all / listed (context_doc_grants): global documents.
  project_scope    text NOT NULL CHECK (project_scope IN ('own', 'all', 'listed')),
  current_version  integer NOT NULL CHECK (current_version >= 1),
  created_by_type  text NOT NULL CHECK (created_by_type IN ('user', 'import', 'agent')),
  created_by_id    text NULL CHECK (created_by_id IS NULL OR length(created_by_id) <= 200),
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  -- Soft delete + retention marker (A-UX-5); the purge removes the rows after purge_after.
  deleted_at       timestamptz NULL,
  deleted_by       uuid NULL REFERENCES users (id),
  delete_reason    text NULL CHECK (delete_reason IS NULL OR length(delete_reason) <= 1000),
  purge_after      timestamptz NULL,
  CHECK ((deleted_at IS NULL) = (purge_after IS NULL)),
  CHECK (deleted_at IS NOT NULL OR (deleted_by IS NULL AND delete_reason IS NULL)),
  CHECK ((namespace = 'global') = (project_scope IN ('all', 'listed'))),
  CHECK (namespace <> 'global' OR write_role IN ('admin', 'owner'))
);

CREATE INDEX context_documents_namespace_idx ON context_documents (namespace, kind) WHERE deleted_at IS NULL;
CREATE INDEX context_documents_purge_idx ON context_documents (purge_after) WHERE deleted_at IS NOT NULL;

---------------------------------------------------------------------------------------------------
-- Versions: immutable, gap-free per document.
---------------------------------------------------------------------------------------------------

CREATE TABLE context_doc_versions (
  doc_id         uuid NOT NULL REFERENCES context_documents (id),
  version        integer NOT NULL CHECK (version >= 1),
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  content        text NOT NULL CHECK (octet_length(content) <= 262144),
  content_hash   text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  sort_order     integer NOT NULL CHECK (sort_order BETWEEN -1000000 AND 1000000),
  -- NULL: every runtime.
  runtimes       text[] NULL CHECK (runtimes IS NULL OR (cardinality(runtimes) BETWEEN 1 AND 5 AND
                   runtimes <@ ARRAY['openhands', 'claude-code', 'codex', 'pi', 'opencode']::text[])),
  change_note    text NULL CHECK (change_note IS NULL OR length(change_note) <= 1000),
  -- Provenance: user (author_id = user id), import (user id + import_source), agent (job + attempt).
  author_type    text NOT NULL CHECK (author_type IN ('user', 'import', 'agent')),
  author_id      text NULL CHECK (author_id IS NULL OR length(author_id) <= 200),
  import_source  text NULL CHECK (import_source IS NULL OR length(import_source) <= 500),
  job_id         uuid NULL REFERENCES jobs (id),
  attempt_id     uuid NULL REFERENCES job_attempts (id),
  worker_id      text NULL CHECK (worker_id IS NULL OR worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  created_at     timestamptz NOT NULL,
  PRIMARY KEY (doc_id, version),
  CHECK ((author_type = 'import') = (import_source IS NOT NULL)),
  CHECK ((author_type = 'agent') = (job_id IS NOT NULL AND attempt_id IS NOT NULL)),
  CHECK (author_type = 'agent' OR author_id IS NOT NULL)
);

ALTER TABLE context_documents
  ADD CONSTRAINT context_documents_current_version_fk FOREIGN KEY (id, current_version)
  REFERENCES context_doc_versions (doc_id, version) DEFERRABLE INITIALLY DEFERRED;

-- Purge transactions set this flag (SET LOCAL remana.context_purge = 'on'); nothing else may delete.
CREATE FUNCTION context_purging() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('remana.context_purge', true), '') = 'on'
$$;

CREATE FUNCTION context_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT max(version) INTO latest FROM context_doc_versions WHERE doc_id = NEW.doc_id;
    IF NEW.version <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'context document % version must be %', NEW.doc_id, COALESCE(latest, 0) + 1
        USING ERRCODE = 'RA000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND context_purging() AND EXISTS (
       SELECT 1 FROM context_documents d WHERE d.id = OLD.doc_id AND d.deleted_at IS NOT NULL) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'context_doc_versions is append-only (% rejected)', TG_OP USING ERRCODE = 'RA000';
END;
$$;

CREATE TRIGGER context_doc_versions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON context_doc_versions
  FOR EACH ROW EXECUTE FUNCTION context_versions_guard();

CREATE FUNCTION context_reject_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME USING ERRCODE = 'RA000';
END;
$$;

CREATE TRIGGER context_doc_versions_no_truncate
  BEFORE TRUNCATE ON context_doc_versions
  FOR EACH STATEMENT EXECUTE FUNCTION context_reject_truncate();

-- Documents: identity columns are immutable, a deleted document stays deleted, rows are removed only by
-- the purge and only once soft-deleted.
CREATE FUNCTION context_documents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF context_purging() AND OLD.deleted_at IS NOT NULL THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'context document % can only be removed by the purge after soft delete', OLD.id
      USING ERRCODE = 'RA000';
  END IF;
  IF (NEW.id, NEW.namespace, NEW.kind, NEW.created_by_type, NEW.created_by_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.namespace, OLD.kind, OLD.created_by_type, OLD.created_by_id, OLD.created_at) THEN
    RAISE EXCEPTION 'context document % identity columns are immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'context document % is deleted', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER context_documents_guard
  BEFORE UPDATE OR DELETE ON context_documents
  FOR EACH ROW EXECUTE FUNCTION context_documents_guard();
CREATE TRIGGER context_documents_no_truncate
  BEFORE TRUNCATE ON context_documents
  FOR EACH STATEMENT EXECUTE FUNCTION context_reject_truncate();

---------------------------------------------------------------------------------------------------
-- Project grants for global documents with project_scope = 'listed'.
---------------------------------------------------------------------------------------------------

CREATE TABLE context_doc_grants (
  doc_id     uuid NOT NULL REFERENCES context_documents (id),
  project    text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  granted_by uuid NOT NULL REFERENCES users (id),
  granted_at timestamptz NOT NULL,
  PRIMARY KEY (doc_id, project)
);

CREATE INDEX context_doc_grants_project_idx ON context_doc_grants (project);

---------------------------------------------------------------------------------------------------
-- Bundle deliveries: provenance record of every context bundle issued for a job (ADR-0010 §4).
-- The first delivery of a job pins the versions; later deliveries reproduce them. No content stored.
---------------------------------------------------------------------------------------------------

CREATE TABLE context_bundle_deliveries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id          uuid NOT NULL REFERENCES jobs (id),
  attempt_id      uuid NULL REFERENCES job_attempts (id),
  project         text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  runtime         text NOT NULL CHECK (runtime IN ('openhands', 'claude-code', 'codex', 'pi', 'opencode')),
  bundle_hash     text NOT NULL CHECK (bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  -- [{layer, namespace, kind, docId, version, contentHash}], in bundle order.
  items           jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  pinned          boolean NOT NULL,
  recipient_type  text NOT NULL CHECK (recipient_type IN ('worker', 'user', 'system')),
  recipient_id    text NULL CHECK (recipient_id IS NULL OR length(recipient_id) <= 200),
  created_at      timestamptz NOT NULL
);

-- Exactly one pinning delivery per job.
CREATE UNIQUE INDEX context_bundle_deliveries_pin_idx ON context_bundle_deliveries (job_id) WHERE pinned;
CREATE INDEX context_bundle_deliveries_job_idx ON context_bundle_deliveries (job_id, id);

CREATE FUNCTION context_deliveries_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'context_bundle_deliveries is append-only (% rejected)', TG_OP USING ERRCODE = 'RA000';
END;
$$;

CREATE TRIGGER context_bundle_deliveries_no_update_delete
  BEFORE UPDATE OR DELETE ON context_bundle_deliveries
  FOR EACH ROW EXECUTE FUNCTION context_deliveries_reject_change();
CREATE TRIGGER context_bundle_deliveries_no_truncate
  BEFORE TRUNCATE ON context_bundle_deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION context_deliveries_reject_change();
REVOKE UPDATE, DELETE, TRUNCATE ON context_doc_versions, context_bundle_deliveries FROM PUBLIC;
