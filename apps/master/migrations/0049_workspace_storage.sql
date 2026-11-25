-- p5-research-workspace-next (docs/design/p5-research-workspace-next.md): workspace follow-ups.
--  1. Per-project file retention and storage quota for workspace projects, enforced by the master (a sweeper and
--     space reservation when files are stored). Pruned files keep their metadata: content NULL + pruned_at/reason.
--  2. Workflow runs on workspace projects (no repository) with run files handed to every step.
--  3. Automations on workspace projects with stored input files and a continue-from rule.
-- Rows are written only through src/workspaces, src/workflows and src/automations.
-- Migration number 0049: renumber at merge if a parallel change took it.

-- 1. Storage policy (NULL: no limit — files stay as long as their job, as before).
ALTER TABLE project_workspaces
  ADD COLUMN artifact_retention_days integer NULL
    CHECK (artifact_retention_days IS NULL OR artifact_retention_days BETWEEN 1 AND 3650),
  ADD COLUMN storage_quota_bytes bigint NULL
    CHECK (storage_quota_bytes IS NULL OR storage_quota_bytes BETWEEN 10485760 AND 1099511627776);

ALTER TABLE job_artifacts
  ALTER COLUMN content DROP NOT NULL,
  ADD COLUMN pruned_at timestamptz NULL,
  ADD COLUMN pruned_reason text NULL CHECK (pruned_reason IS NULL OR pruned_reason IN ('retention', 'quota')),
  ADD CONSTRAINT job_artifacts_pruned_check
    CHECK ((content IS NULL) = (pruned_at IS NOT NULL) AND (pruned_at IS NULL) = (pruned_reason IS NULL));
ALTER TABLE job_inputs
  ALTER COLUMN content DROP NOT NULL,
  ADD COLUMN pruned_at timestamptz NULL,
  ADD COLUMN pruned_reason text NULL CHECK (pruned_reason IS NULL OR pruned_reason IN ('retention', 'quota')),
  ADD CONSTRAINT job_inputs_pruned_check
    CHECK ((content IS NULL) = (pruned_at IS NOT NULL) AND (pruned_at IS NULL) = (pruned_reason IS NULL));
-- A workflow step's job gets the artifacts of its upstream steps as inputs (`upstream`, replaced when the step is
-- released again).
ALTER TABLE job_inputs DROP CONSTRAINT job_inputs_source_check;
ALTER TABLE job_inputs ADD CONSTRAINT job_inputs_source_check
  CHECK (source IN ('upload', 'artifact', 'upstream'));
-- Sweeper scans: stored (not pruned) files by age.
CREATE INDEX job_artifacts_stored_idx ON job_artifacts (created_at) WHERE pruned_at IS NULL;
CREATE INDEX job_inputs_stored_idx ON job_inputs (created_at) WHERE pruned_at IS NULL;

-- 2. Workflow runs of a workspace project have no repository.
ALTER TABLE workflow_runs ALTER COLUMN repository DROP NOT NULL;

-- Files of a workflow run (uploaded or continued from a job), handed to every step's job as inputs. Bounded like
-- job inputs (≤ 10 files, ≤ 5 MiB each, ≤ 10 MiB per run), secret-scanned before they are stored. Pruned by the
-- project's retention once the run has ended.
CREATE TABLE workflow_run_files (
  run_id        uuid NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
  input_id      text NOT NULL CHECK (input_id ~ '^in-[a-z0-9]{1,32}$'),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  media_type    text NOT NULL CHECK (media_type ~ '^[a-z]+/[A-Za-z0-9.+-]+$'),
  size_bytes    integer NOT NULL CHECK (size_bytes BETWEEN 0 AND 5242880),
  sha256        text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  content       bytea NULL,
  source        text NOT NULL CHECK (source IN ('upload', 'artifact')),
  source_job_id uuid NULL,
  created_at    timestamptz NOT NULL,
  pruned_at     timestamptz NULL,
  PRIMARY KEY (run_id, input_id),
  UNIQUE (run_id, name),
  CHECK ((content IS NULL) = (pruned_at IS NOT NULL)),
  CHECK (content IS NULL OR octet_length(content) = size_bytes)
);

-- 3. Input files stored with an automation (a template: every run's job gets a fresh copy).
CREATE TABLE automation_files (
  automation_id uuid NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  input_id      text NOT NULL CHECK (input_id ~ '^in-[a-z0-9]{1,32}$'),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  media_type    text NOT NULL CHECK (media_type ~ '^[a-z]+/[A-Za-z0-9.+-]+$'),
  size_bytes    integer NOT NULL CHECK (size_bytes BETWEEN 0 AND 5242880),
  sha256        text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  content       bytea NOT NULL,
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (automation_id, input_id),
  UNIQUE (automation_id, name),
  CHECK (octet_length(content) = size_bytes)
);

-- Continue-from rule of an automation on a workspace project: {"kind":"job","jobId":…} | {"kind":"last-run"} |
-- {"kind":"chain-source"} — the artifacts of that job become the run's inputs.
ALTER TABLE automations ADD COLUMN continue_from jsonb NULL
  CHECK (continue_from IS NULL OR (jsonb_typeof(continue_from) = 'object'
         AND continue_from->>'kind' IN ('job', 'last-run', 'chain-source')));
