-- p5-research-workspace (docs/design/p5-research-workspace.md): repository-less work areas. A project is either a
-- `repository` project (all existing ones) or a `workspace`: its jobs run in an empty per-attempt scratch
-- directory, take uploaded input files and return artifacts; its egress policy decides how much of the web the
-- agent may reach. Rows are written only through src/workspaces/*.

ALTER TABLE projects
  ADD COLUMN kind text NOT NULL DEFAULT 'repository' CHECK (kind IN ('repository', 'workspace'));

CREATE TABLE project_workspaces (
  project     text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  -- none: model provider APIs only; allowlist: + allow_hosts; web: + any public HTTPS host (egress proxy).
  egress      text NOT NULL CHECK (egress IN ('none', 'allowlist', 'web')),
  allow_hosts jsonb NOT NULL DEFAULT '[]'::jsonb
                CHECK (jsonb_typeof(allow_hosts) = 'array' AND jsonb_array_length(allow_hosts) <= 64),
  -- NULL for the default project created by this migration.
  updated_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL
);

-- Input files of workspace jobs (uploaded with the job or copied from another job's artifacts). Bounded by the
-- API (≤ 10 files, ≤ 5 MiB each, ≤ 10 MiB per job) and secret-scanned before they are stored.
CREATE TABLE job_inputs (
  job_id        uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  input_id      text NOT NULL CHECK (input_id ~ '^in-[a-z0-9]{1,32}$'),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  media_type    text NOT NULL CHECK (media_type ~ '^[a-z]+/[A-Za-z0-9.+-]+$'),
  size_bytes    integer NOT NULL CHECK (size_bytes BETWEEN 0 AND 5242880),
  sha256        text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  content       bytea NOT NULL,
  source        text NOT NULL CHECK (source IN ('upload', 'artifact')),
  source_job_id uuid NULL,
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (job_id, input_id),
  UNIQUE (job_id, name),
  CHECK (octet_length(content) = size_bytes)
);

-- Staging of ARTIFACT_CHUNK payloads until the ARTIFACT_REF commit assembles and verifies them.
CREATE TABLE job_artifact_chunks (
  attempt_id  uuid NOT NULL,
  job_id      uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  artifact_id text NOT NULL CHECK (artifact_id ~ '^ws-[a-z0-9-]{1,100}$'),
  idx         integer NOT NULL CHECK (idx BETWEEN 0 AND 1023),
  data        bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 131072),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (attempt_id, artifact_id, idx)
);
CREATE INDEX job_artifact_chunks_received_idx ON job_artifact_chunks (received_at);

-- Committed artifacts (outputs under out/ and the run summary), verified against the worker's SHA-256 and size.
CREATE TABLE job_artifacts (
  attempt_id  uuid NOT NULL,
  job_id      uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  artifact_id text NOT NULL CHECK (artifact_id ~ '^ws-[a-z0-9-]{1,100}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  media_type  text NOT NULL CHECK (media_type ~ '^[a-z]+/[A-Za-z0-9.+-]+$'),
  size_bytes  integer NOT NULL CHECK (size_bytes BETWEEN 0 AND 5242880),
  -- Of the stored content (after the master's redaction pass; equals the worker's when nothing was redacted).
  sha256      text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  kind        text NOT NULL CHECK (kind IN ('output', 'summary')),
  redacted    boolean NOT NULL,
  content     bytea NOT NULL,
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (attempt_id, artifact_id),
  CHECK (octet_length(content) = size_bytes)
);
CREATE INDEX job_artifacts_job_idx ON job_artifacts (job_id, created_at);

-- A workspace settings change re-resolves the managed configuration of every worker assigned to it.
ALTER TABLE worker_config_versions DROP CONSTRAINT worker_config_versions_cause_check;
ALTER TABLE worker_config_versions ADD CONSTRAINT worker_config_versions_cause_check
  CHECK (cause IN ('edit', 'bulk', 'project', 'rollback', 'adopt', 'repository', 'catalog', 'workspace'));

-- The default work area for research and general tasks ("Genel"), with web access.
INSERT INTO projects (id, name, kind, created_at) VALUES ('genel', 'Genel', 'workspace', now())
  ON CONFLICT (id) DO NOTHING;
INSERT INTO project_workspaces (project, egress, updated_at)
  SELECT 'genel', 'web', now() FROM projects WHERE id = 'genel' AND kind = 'workspace'
  ON CONFLICT (project) DO NOTHING;
