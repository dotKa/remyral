-- p14-skill-import (ADR-0054, docs/design/p14-mcp-skills.md §3, §5.1): skills imported from the panel without manual
-- signing (folder / zip / GitHub URL pinned to a commit), the provenance of every skill version, the per-project
-- "offline-signed only" trust level — and the catalog tables of the later MCP phases (P3/P4), created now because the
-- design puts them in this migration; no code writes them yet. Additive only: older code ignores the new tables and
-- columns (rollback: leave them unused).
-- Migration number 0102: renumber at merge if a parallel change took it.
--
-- Deliberately NOT here (they belong to the phase that writes them, so parallel migrations do not fight over the same
-- CHECK lists): chat_drafts.kind + skill_import / mcp_install (P2 / P5), fleet_tool_actions.kind and worker_ops.kind +
-- mcp.* (P4), approval action tool.mcp and notification kind mcp.installed (P3).

-- 1. Import previews. Nothing is signed or stored as a version until an admin publishes (always-fresh step-up).
CREATE TABLE skill_imports (
  id                uuid PRIMARY KEY,
  source_kind       text NOT NULL CHECK (source_kind IN ('upload', 'zip', 'github', 'catalog', 'chat')),
  -- Where the files came from: {fileName} | {repo, path, ref, commit, url} | … Never a credential.
  source            jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object' AND octet_length(source::text) <= 4096),
  -- The accepted files {path: UTF-8 text} (cleared when published or discarded; the version keeps its own copy).
  files             jsonb NOT NULL CHECK (jsonb_typeof(files) = 'object' AND octet_length(files::text) <= 1048576),
  -- Files that were left out ({path, size, reason}) and the findings (secrets by rule + position only, never a value).
  excluded          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(excluded) = 'array'),
  findings          jsonb NOT NULL CHECK (jsonb_typeof(findings) = 'array'),
  -- Suggested id / title / description / version from SKILL.md frontmatter, the license file summary.
  manifest_preview  jsonb NOT NULL CHECK (jsonb_typeof(manifest_preview) = 'object'),
  blocked           boolean NOT NULL,
  state             text NOT NULL CHECK (state IN ('previewed', 'published', 'discarded', 'expired')),
  published_skill   text NULL CHECK (published_skill IS NULL OR published_skill ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  published_version text NULL CHECK (published_version IS NULL OR length(published_version) <= 64),
  created_by        uuid NOT NULL REFERENCES users (id),
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX skill_imports_user_idx ON skill_imports (created_by, state, created_at DESC);
CREATE INDEX skill_imports_expiry_idx ON skill_imports (expires_at) WHERE state = 'previewed';

-- 2. Provenance of a version, set at insert (the immutable trigger of 0022 still refuses every UPDATE):
--    {kind: upload|zip|github|catalog|chat, repo?, path?, commit?, ref?, fileName?, importId?}. NULL = the offline
--    upload path (`POST /skills` with a bundle signed by the owner's key). `layout` 2 is reserved for P2
--    (skills-layout-v2); everything written today is layout 1.
ALTER TABLE skill_versions
  ADD COLUMN provenance jsonb NULL CHECK (provenance IS NULL OR (jsonb_typeof(provenance) = 'object'
                                                                  AND octet_length(provenance::text) <= 2048)),
  ADD COLUMN layout smallint NOT NULL DEFAULT 1 CHECK (layout IN (1, 2));

-- 3. Per-project skill trust: 'offline-only' = the master assigns / delivers no panel-signed version to the project's
--    jobs, and workers (skill-trust-v1) refuse one (ASSIGN_JOB execution.skillTrust). No row = 'any'.
CREATE TABLE project_skill_settings (
  project_id  text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  trust       text NOT NULL DEFAULT 'any' CHECK (trust IN ('any', 'offline-only')),
  updated_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL
);

-- 4. Notification kind 'skills.panel_published' (owners, critical): appended to whatever the constraints allow now.
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
    IF def ~ '\{' THEN
      kinds := string_to_array(substring(def from '\{([^}]*)\}'), ',');
    ELSE
      SELECT array_agg(DISTINCT m[1]) INTO kinds FROM regexp_matches(def, '''([a-z0-9_.]+)''', 'g') AS m;
    END IF;
    IF coalesce(array_length(kinds, 1), 0) < 2 THEN
      RAISE EXCEPTION 'could not read the kinds of %', c;
    END IF;
    kinds := kinds || ARRAY['skills.panel_published'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, c, kinds);
  END LOOP;
END;
$$;

-- 5. MCP catalog (P3/P4; design §2, §5.1). Created now, written by no code yet.
CREATE TABLE mcp_servers (
  id           text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,31}$'
                                       AND id !~ '^(remana|subtask)' AND id NOT IN ('admin', 'preview', 'deploy')),
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description  text NOT NULL DEFAULT '' CHECK (length(description) <= 1024),
  created_by   uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL,
  archived_at  timestamptz NULL
);

-- An immutable, signed server spec ("remana-mcp/v1\n" + spec bytes).
CREATE TABLE mcp_server_versions (
  server_id     text NOT NULL REFERENCES mcp_servers (id),
  version       text NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
  transport     text NOT NULL CHECK (transport IN ('stdio', 'http', 'sse')),
  spec          bytea NOT NULL CHECK (octet_length(spec) <= 16384),
  spec_sha256   text NOT NULL CHECK (spec_sha256 ~ '^[0-9a-f]{64}$'),
  signature     text NOT NULL CHECK (signature ~ '^[A-Za-z0-9_-]{86}$'),
  key_id        text NOT NULL CHECK (key_id ~ '^[0-9a-f]{16}$'),
  signer        text NOT NULL CHECK (signer IN ('offline', 'panel')),
  egress_hosts  text[] NOT NULL DEFAULT '{}' CHECK (cardinality(egress_hosts) <= 16),
  runtimes      text[] NOT NULL CHECK (cardinality(runtimes) BETWEEN 1 AND 4
                                       AND runtimes <@ ARRAY['claude-code', 'codex', 'pi', 'opencode']::text[]),
  provenance    jsonb NULL CHECK (provenance IS NULL OR jsonb_typeof(provenance) = 'object'),
  created_by    uuid NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (server_id, version)
);
CREATE FUNCTION mcp_rows_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MCP server versions are immutable' USING ERRCODE = 'RA000';
END
$$;
CREATE TRIGGER mcp_server_versions_immutable BEFORE UPDATE ON mcp_server_versions
  FOR EACH ROW EXECUTE FUNCTION mcp_rows_immutable();

-- The canary's lockfile: every later machine installs exactly these transitive packages.
CREATE TABLE mcp_lockfiles (
  server_id           text NOT NULL,
  version             text NOT NULL,
  manager             text NOT NULL CHECK (manager IN ('npm', 'pypi')),
  lock                bytea NOT NULL CHECK (octet_length(lock) <= 2097152),
  sha256              text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  produced_on_worker  text NOT NULL,
  created_at          timestamptz NOT NULL,
  PRIMARY KEY (server_id, version),
  FOREIGN KEY (server_id, version) REFERENCES mcp_server_versions (server_id, version)
);

CREATE TABLE mcp_worker_installs (
  worker_id   text NOT NULL,
  server_id   text NOT NULL,
  version     text NOT NULL,
  state       text NOT NULL CHECK (state IN ('queued', 'installing', 'installed', 'failed', 'removed')),
  digest      text NULL CHECK (digest IS NULL OR digest ~ '^sha256:[0-9a-f]{64}$'),
  error       text NULL CHECK (error IS NULL OR length(error) <= 300),
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (worker_id, server_id, version),
  FOREIGN KEY (server_id, version) REFERENCES mcp_server_versions (server_id, version)
);

-- Tool list from a worker-side probe: untrusted text, rendered as text.
CREATE TABLE mcp_server_tools (
  server_id         text NOT NULL,
  version           text NOT NULL,
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  description       text NOT NULL DEFAULT '' CHECK (octet_length(description) <= 1024),
  schema_sha256     text NOT NULL CHECK (schema_sha256 ~ '^[0-9a-f]{64}$'),
  probed_on_worker  text NOT NULL,
  probed_at         timestamptz NOT NULL,
  PRIMARY KEY (server_id, version, name),
  FOREIGN KEY (server_id, version) REFERENCES mcp_server_versions (server_id, version)
);

-- Secret slot → vault credential id (never a value), per server and optionally per project ('*' = all).
CREATE TABLE mcp_secret_bindings (
  server_id            text NOT NULL REFERENCES mcp_servers (id),
  project              text NOT NULL CHECK (project = '*' OR project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  slot                 text NOT NULL CHECK (slot ~ '^[a-z][a-z0-9_]{0,31}$'),
  vault_credential_id  text NOT NULL CHECK (length(vault_credential_id) BETWEEN 1 AND 64),
  created_by           uuid NOT NULL REFERENCES users (id),
  updated_at           timestamptz NOT NULL,
  PRIMARY KEY (server_id, project, slot)
);

-- allow / ask / deny per tool glob; unlisted tools are denied.
CREATE TABLE mcp_tool_policies (
  server_id   text NOT NULL REFERENCES mcp_servers (id),
  project     text NOT NULL CHECK (project = '*' OR project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  position    smallint NOT NULL CHECK (position BETWEEN 0 AND 63),
  tool_glob   text NOT NULL CHECK (length(tool_glob) BETWEEN 1 AND 128),
  effect      text NOT NULL CHECK (effect IN ('allow', 'ask', 'deny')),
  updated_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (server_id, project, position)
);

CREATE TABLE mcp_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   text NOT NULL REFERENCES mcp_servers (id),
  project     text NOT NULL CHECK (project = '*' OR project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  runtimes    text[] NULL CHECK (runtimes IS NULL OR (cardinality(runtimes) BETWEEN 1 AND 4
                                 AND runtimes <@ ARRAY['claude-code', 'codex', 'pi', 'opencode']::text[])),
  version     text NULL CHECK (version IS NULL OR length(version) <= 64),
  created_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  UNIQUE (server_id, project)
);
CREATE INDEX mcp_assignments_project_idx ON mcp_assignments (project);

-- Authoritative project switch: default off (no row = off).
CREATE TABLE project_mcp_settings (
  project_id  text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  allowed     boolean NOT NULL DEFAULT false,
  updated_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL
);

-- Per-job pins (first issue wins), like job_skill_pins / job_skill_sets.
CREATE TABLE job_mcp_pins (
  job_id         uuid NOT NULL REFERENCES jobs (id),
  server_id      text NOT NULL,
  version        text NOT NULL,
  spec_sha256    text NOT NULL CHECK (spec_sha256 ~ '^[0-9a-f]{64}$'),
  policy_sha256  text NOT NULL CHECK (policy_sha256 ~ '^[0-9a-f]{64}$'),
  pinned_at      timestamptz NOT NULL,
  PRIMARY KEY (job_id, server_id)
);
CREATE TABLE job_mcp_sets (
  job_id     uuid PRIMARY KEY REFERENCES jobs (id),
  set_hash   text NOT NULL CHECK (set_hash = 'none' OR set_hash ~ '^sha256:[0-9a-f]{64}$'),
  pinned_at  timestamptz NOT NULL
);

-- One row per MCP tool call (metadata only: never arguments or results).
CREATE TABLE job_mcp_calls (
  job_id        uuid NOT NULL REFERENCES jobs (id),
  attempt_id    uuid NOT NULL,
  seq           integer NOT NULL CHECK (seq >= 0),
  server_id     text NOT NULL,
  tool          text NOT NULL CHECK (length(tool) BETWEEN 1 AND 128),
  decision      text NOT NULL CHECK (decision IN ('allow', 'ask', 'deny')),
  outcome       text NOT NULL CHECK (outcome IN ('ok', 'error', 'timeout', 'denied')),
  duration_ms   integer NOT NULL CHECK (duration_ms >= 0),
  args_bytes    integer NOT NULL CHECK (args_bytes >= 0),
  args_sha256   text NOT NULL CHECK (args_sha256 ~ '^[0-9a-f]{64}$'),
  result_bytes  integer NOT NULL CHECK (result_bytes >= 0),
  at            timestamptz NOT NULL,
  PRIMARY KEY (job_id, attempt_id, seq)
);
