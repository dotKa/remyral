-- p6-skills (docs/design/p6-skills.md; ADR-0010, threat model T-SUP, T-INJ): signed, versioned skills.
--
-- A skill is a context document in the namespace `skill:<id>` (reserved since 0007, enabled here). Every
-- skill version is one immutable context version whose content is the SKILL.md text, plus the signed
-- material in skill_versions (the exact manifest bytes, the detached Ed25519 signature, the key id) and the
-- other files in skill_files. Rows are written only by src/skills/service.ts after the signature verified
-- against SKILLS_PUBLIC_KEYS; the context API refuses direct writes to skill namespaces.

-- 1. Allow skill namespaces in context documents and deletion receipts. Skill documents are project-scope
--    'own' (who receives a skill is decided by skill_assignments, never by context grants).
ALTER TABLE context_documents DROP CONSTRAINT context_documents_namespace_check;
ALTER TABLE context_documents ADD CONSTRAINT context_documents_namespace_check
  CHECK (namespace = 'global' OR namespace ~ '^project:[A-Za-z0-9_.:-]{1,128}$'
         OR namespace ~ '^skill:[a-z0-9]+(-[a-z0-9]+)*$' AND length(namespace) <= 70);
ALTER TABLE context_documents ADD CONSTRAINT context_documents_skill_shape
  CHECK (namespace NOT LIKE 'skill:%' OR (kind = 'instructions' AND write_role IN ('admin', 'owner')));

ALTER TABLE context_deletion_receipts DROP CONSTRAINT context_deletion_receipts_namespace_check;
ALTER TABLE context_deletion_receipts ADD CONSTRAINT context_deletion_receipts_namespace_check
  CHECK (namespace = 'global' OR namespace ~ '^project:[A-Za-z0-9_.:-]{1,128}$'
         OR namespace ~ '^skill:[a-z0-9]+(-[a-z0-9]+)*$' AND length(namespace) <= 70);

-- 2. Signed versions. One row per (skill, semantic version); points at the context version that holds
--    SKILL.md. Purging the skill document removes its versions (cascade) — pinned jobs then fail closed.
CREATE TABLE skill_versions (
  skill_id         text NOT NULL CHECK (skill_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(skill_id) <= 64),
  version          text NOT NULL CHECK (length(version) <= 64),
  doc_id           uuid NOT NULL,
  doc_version      integer NOT NULL,
  -- The exact signed manifest bytes and their sha256 (hex): pins the whole version.
  manifest         bytea NOT NULL CHECK (octet_length(manifest) <= 16384),
  manifest_sha256  text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  signature        text NOT NULL CHECK (signature ~ '^[A-Za-z0-9_-]{86}$'),
  key_id           text NOT NULL CHECK (key_id ~ '^[0-9a-f]{16}$'),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description      text NOT NULL CHECK (length(description) BETWEEN 1 AND 1024),
  runtimes         text[] NOT NULL CHECK (cardinality(runtimes) BETWEEN 1 AND 5 AND
                     runtimes <@ ARRAY['openhands', 'claude-code', 'codex', 'pi', 'opencode']::text[]),
  file_count       integer NOT NULL CHECK (file_count BETWEEN 1 AND 32),
  total_bytes      integer NOT NULL CHECK (total_bytes BETWEEN 0 AND 131072),
  uploaded_by      uuid NOT NULL REFERENCES users (id),
  uploaded_at      timestamptz NOT NULL,
  PRIMARY KEY (skill_id, version),
  UNIQUE (doc_id, doc_version),
  FOREIGN KEY (doc_id, doc_version) REFERENCES context_doc_versions (doc_id, version) ON DELETE CASCADE
);

CREATE TABLE skill_files (
  skill_id    text NOT NULL,
  version     text NOT NULL,
  path        text NOT NULL CHECK (length(path) BETWEEN 1 AND 160),
  content     text NOT NULL CHECK (octet_length(content) <= 65536),
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  executable  boolean NOT NULL,
  PRIMARY KEY (skill_id, version, path),
  FOREIGN KEY (skill_id, version) REFERENCES skill_versions (skill_id, version) ON DELETE CASCADE
);

-- Signed material is immutable (defence in depth; only a cascade from the context purge removes rows).
CREATE FUNCTION skill_rows_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'skill versions and files are immutable' USING ERRCODE = 'RA000';
END
$$;
CREATE TRIGGER skill_versions_immutable BEFORE UPDATE ON skill_versions
  FOR EACH ROW EXECUTE FUNCTION skill_rows_immutable();
CREATE TRIGGER skill_files_immutable BEFORE UPDATE ON skill_files
  FOR EACH ROW EXECUTE FUNCTION skill_rows_immutable();

-- 3. Assignment of a skill to a project (optionally only some runtimes, optionally pinned to a version;
--    NULL = the newest uploaded version at the time a job is first issued).
CREATE TABLE skill_assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id     text NOT NULL CHECK (skill_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(skill_id) <= 64),
  project      text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  runtimes     text[] NULL CHECK (runtimes IS NULL OR (cardinality(runtimes) BETWEEN 1 AND 5 AND
                 runtimes <@ ARRAY['openhands', 'claude-code', 'codex', 'pi', 'opencode']::text[])),
  version      text NULL CHECK (version IS NULL OR length(version) <= 64),
  created_by   uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  UNIQUE (skill_id, project)
);
CREATE INDEX skill_assignments_project_idx ON skill_assignments (project);

-- 4. Per-job pins (first issue wins; every later attempt/worker gets exactly these versions). No content.
CREATE TABLE job_skill_pins (
  job_id           uuid NOT NULL REFERENCES jobs (id),
  skill_id         text NOT NULL,
  version          text NOT NULL,
  manifest_sha256  text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  pinned_at        timestamptz NOT NULL,
  PRIMARY KEY (job_id, skill_id)
);

CREATE TABLE job_skill_sets (
  job_id     uuid PRIMARY KEY REFERENCES jobs (id),
  -- sha256:<hex> of the pinned set (packages/protocol skillSetHash); 'none' pins "no skills".
  set_hash   text NOT NULL CHECK (set_hash = 'none' OR set_hash ~ '^sha256:[0-9a-f]{64}$'),
  pinned_at  timestamptz NOT NULL
);
