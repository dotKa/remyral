-- p3-runtime-policy (ADR-0012 rule 1, ADR-0008, ADR-0014, threat model T-SUP-1): versioned, master-managed
-- runtime policies (allowed runtimes, exact pins, auth modes, model profiles), staged canary rollout,
-- rollback, and per-worker assignment + delivery state.
-- Rows are written only through src/runtime-policy/* (RuntimePolicyService). Triggers are defence in
-- depth (SQLSTATE RA000 like 0003/0007). Design: docs/design/p3-runtime-policy.md.

---------------------------------------------------------------------------------------------------
-- Policies: one row per named policy (= worker group); pointers into the immutable versions.
---------------------------------------------------------------------------------------------------

CREATE TABLE runtime_policies (
  name              text PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  description       text NULL CHECK (description IS NULL OR length(description) <= 500),
  -- The version every worker of the group receives (NULL until a version is activated).
  active_version    integer NULL CHECK (active_version IS NULL OR active_version >= 1),
  -- A staged version delivered only to the group's canary workers (NULL: no rollout in progress).
  canary_version    integer NULL CHECK (canary_version IS NULL OR canary_version >= 1),
  -- The version that was active before the current one: the default rollback target.
  previous_version  integer NULL CHECK (previous_version IS NULL OR previous_version >= 1),
  CHECK (canary_version IS NULL OR canary_version IS DISTINCT FROM active_version),
  created_at        timestamptz NOT NULL,
  created_by        uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL,
  updated_by        uuid NULL REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE runtime_policy_versions (
  policy         text NOT NULL REFERENCES runtime_policies (name),
  version        integer NOT NULL CHECK (version >= 1),
  -- @remana/protocol RuntimePolicyDocument (validated by the service; no credentials, only names).
  document       jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  -- Lowercase hex SHA-256 of the canonical JSON of `document` (runtimePolicyHash).
  document_hash  text NOT NULL CHECK (document_hash ~ '^[a-f0-9]{64}$'),
  change_note    text NULL CHECK (change_note IS NULL OR length(change_note) <= 1000),
  created_at     timestamptz NOT NULL,
  created_by     uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  PRIMARY KEY (policy, version)
);

ALTER TABLE runtime_policies
  ADD CONSTRAINT runtime_policies_active_fk FOREIGN KEY (name, active_version)
    REFERENCES runtime_policy_versions (policy, version) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT runtime_policies_canary_fk FOREIGN KEY (name, canary_version)
    REFERENCES runtime_policy_versions (policy, version) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT runtime_policies_previous_fk FOREIGN KEY (name, previous_version)
    REFERENCES runtime_policy_versions (policy, version) DEFERRABLE INITIALLY DEFERRED;

-- Versions are immutable and gap-free; policies are never deleted (history is part of the audit trail).
CREATE FUNCTION runtime_policy_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT max(version) INTO latest FROM runtime_policy_versions WHERE policy = NEW.policy;
    IF NEW.version <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'runtime policy % version must be %', NEW.policy, COALESCE(latest, 0) + 1
        USING ERRCODE = 'RA000';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'runtime_policy_versions is append-only (% rejected)', TG_OP USING ERRCODE = 'RA000';
END;
$$;

CREATE TRIGGER runtime_policy_versions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON runtime_policy_versions
  FOR EACH ROW EXECUTE FUNCTION runtime_policy_versions_guard();

CREATE FUNCTION runtime_policy_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rejects % (policies are never removed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'RA000';
END;
$$;

CREATE TRIGGER runtime_policies_no_delete
  BEFORE DELETE ON runtime_policies
  FOR EACH ROW EXECUTE FUNCTION runtime_policy_reject_change();
CREATE TRIGGER runtime_policies_no_truncate
  BEFORE TRUNCATE ON runtime_policies
  FOR EACH STATEMENT EXECUTE FUNCTION runtime_policy_reject_change();
CREATE TRIGGER runtime_policy_versions_no_truncate
  BEFORE TRUNCATE ON runtime_policy_versions
  FOR EACH STATEMENT EXECUTE FUNCTION runtime_policy_reject_change();

---------------------------------------------------------------------------------------------------
-- Per-worker assignment (no row / NULL policy: the `default` policy) and delivery state.
---------------------------------------------------------------------------------------------------

CREATE TABLE worker_runtime_policies (
  worker_id           text PRIMARY KEY REFERENCES workers (id) ON DELETE CASCADE,
  policy              text NULL REFERENCES runtime_policies (name),
  -- Canary workers receive a policy's staged version before the rest of the group.
  canary              boolean NOT NULL DEFAULT false,
  assigned_at         timestamptz NULL,
  assigned_by         uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  -- Last UPDATE_POLICY queued for the worker (generation = UPDATE_POLICY.policyVersion, monotonic).
  generation          bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  delivered_policy    text NULL,
  delivered_version   integer NULL,
  delivered_stage     text NULL CHECK (delivered_stage IS NULL OR delivered_stage IN ('active', 'canary')),
  delivered_hash      text NULL CHECK (delivered_hash IS NULL OR delivered_hash ~ '^[a-f0-9]{64}$'),
  delivered_at        timestamptz NULL,
  -- What the worker reports as applied (CAPABILITIES.runtimePolicy).
  applied_policy      text NULL,
  applied_version     integer NULL,
  applied_hash        text NULL CHECK (applied_hash IS NULL OR applied_hash ~ '^[a-f0-9]{64}$'),
  applied_at          timestamptz NULL
);

CREATE INDEX worker_runtime_policies_policy_idx ON worker_runtime_policies (policy);

---------------------------------------------------------------------------------------------------
-- p6-context-policy (A-UX-5 deletion half, T-INJ-5, ADR-0006/0010): per-namespace retention, legal hold
-- and agent memory-write policy; append-only deletion receipts (what was deleted when and by whom — never
-- content). Written only through src/context/* (ContextStore, ContextPolicyService).
-- Design: docs/design/p6-context-policy.md.
---------------------------------------------------------------------------------------------------

CREATE TABLE context_namespace_policies (
  namespace              text PRIMARY KEY
                           CHECK (namespace = 'global' OR namespace ~ '^project:[A-Za-z0-9_.:-]{1,128}$'),
  version                integer NOT NULL CHECK (version >= 1),
  max_age_days           integer NULL CHECK (max_age_days IS NULL OR max_age_days BETWEEN 1 AND 3650),
  max_versions           integer NULL CHECK (max_versions IS NULL OR max_versions BETWEEN 1 AND 1000),
  legal_hold             boolean NOT NULL,
  delete_retention_days  integer NOT NULL CHECK (delete_retention_days BETWEEN 0 AND 365),
  memory_enabled         boolean NOT NULL,
  memory_max_bytes       integer NOT NULL CHECK (memory_max_bytes BETWEEN 256 AND 262144),
  memory_max_per_job     integer NOT NULL CHECK (memory_max_per_job BETWEEN 0 AND 1000),
  memory_max_per_hour    integer NOT NULL CHECK (memory_max_per_hour BETWEEN 0 AND 10000),
  updated_at             timestamptz NOT NULL,
  updated_by             uuid NULL REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE context_deletion_receipts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL,
  -- delete: soft delete by a user; expire: soft delete by max age; prune: old versions removed;
  -- purge: document hard-deleted after its retention marker.
  action          text NOT NULL CHECK (action IN ('delete', 'expire', 'prune', 'purge')),
  -- No foreign key: the receipt outlives the purged document.
  doc_id          uuid NOT NULL,
  namespace       text NOT NULL CHECK (namespace = 'global' OR namespace ~ '^project:[A-Za-z0-9_.:-]{1,128}$'),
  kind            text NOT NULL CHECK (kind IN ('instructions', 'memory', 'reference')),
  versions        integer[] NOT NULL,
  -- sha256:<hex> of each affected version's content (proof of what was removed, not the content).
  content_hashes  text[] NOT NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_id        text NULL CHECK (actor_id IS NULL OR length(actor_id) <= 200),
  reason          text NULL CHECK (reason IS NULL OR length(reason) <= 1000),
  purge_after     timestamptz NULL
);

CREATE INDEX context_deletion_receipts_ns_idx ON context_deletion_receipts (namespace, id);
CREATE INDEX context_deletion_receipts_doc_idx ON context_deletion_receipts (doc_id, id);

CREATE FUNCTION context_receipts_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'context_deletion_receipts is append-only (% rejected)', TG_OP USING ERRCODE = 'RA000';
END;
$$;

CREATE TRIGGER context_deletion_receipts_no_update_delete
  BEFORE UPDATE OR DELETE ON context_deletion_receipts
  FOR EACH ROW EXECUTE FUNCTION context_receipts_reject_change();
CREATE TRIGGER context_deletion_receipts_no_truncate
  BEFORE TRUNCATE ON context_deletion_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION context_receipts_reject_change();
REVOKE UPDATE, DELETE, TRUNCATE ON context_deletion_receipts FROM PUBLIC;

CREATE FUNCTION context_on_hold(ns text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT legal_hold FROM context_namespace_policies WHERE namespace = ns), false)
$$;

-- Version pruning (max versions): a prune transaction (SET LOCAL remana.context_prune = 'on') may remove a
-- non-current version of a live document outside legal hold. Everything else stays as in 0007.
CREATE OR REPLACE FUNCTION context_versions_guard() RETURNS trigger
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
       SELECT 1 FROM context_documents d
        WHERE d.id = OLD.doc_id AND d.deleted_at IS NOT NULL AND NOT context_on_hold(d.namespace)) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' AND COALESCE(current_setting('remana.context_prune', true), '') = 'on' AND EXISTS (
       SELECT 1 FROM context_documents d
        WHERE d.id = OLD.doc_id AND d.deleted_at IS NULL AND d.current_version <> OLD.version
          AND NOT context_on_hold(d.namespace)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'context_doc_versions is append-only (% rejected)', TG_OP USING ERRCODE = 'RA000';
END;
$$;

-- Legal hold: no soft delete and no purge of documents in a held namespace (defence in depth).
CREATE FUNCTION context_documents_hold_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF context_on_hold(OLD.namespace) AND
     (TG_OP = 'DELETE' OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)) THEN
    RAISE EXCEPTION 'context namespace % is under legal hold', OLD.namespace USING ERRCODE = 'RA000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER context_documents_hold_guard
  BEFORE UPDATE OR DELETE ON context_documents
  FOR EACH ROW EXECUTE FUNCTION context_documents_hold_guard();
