-- p8-orchestration (ADR-0031, docs/design/p8-orchestration.md): agent-requested sub-jobs, the project switch and
-- delegation runtimes, and the placement explanation of workflow steps. Additive only.

-- 1. Project execution policy: agents may request sub-jobs (off by default) and the runtimes agent-chosen work may use
--    besides the requester's own (sub-jobs and planned workflow tasks).
ALTER TABLE projects
  ADD COLUMN subtasks_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN delegation_runtimes text[] NOT NULL DEFAULT '{}'
    CHECK (delegation_runtimes <@ ARRAY['claude-code', 'codex', 'pi', 'opencode']::text[]
           AND cardinality(delegation_runtimes) <= 4);

-- 2. Sub-jobs: one row per child job, written once by the master in the child's creation transaction; only
--    `delivered` (the parent inputs the child's files became) is filled in later, once.
CREATE TABLE job_subtasks (
  child_job_id       uuid PRIMARY KEY REFERENCES jobs (id),
  parent_job_id      uuid NOT NULL REFERENCES jobs (id),
  root_job_id        uuid NOT NULL REFERENCES jobs (id),
  depth              integer NOT NULL CHECK (depth BETWEEN 1 AND 2),
  request_id         uuid NOT NULL,
  parent_attempt_id  uuid NOT NULL,
  worker_id          text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  title              text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  wait               boolean NOT NULL,
  requested_runtime  text NULL CHECK (requested_runtime IS NULL OR requested_runtime IN ('claude-code', 'codex', 'pi', 'opencode')),
  requires           text[] NOT NULL DEFAULT '{}' CHECK (cardinality(requires) <= 8),
  -- How the runtime and limits were chosen (shown on the job page): {runtime, source, notes[], limits}.
  placement          jsonb NOT NULL CHECK (jsonb_typeof(placement) = 'object'),
  delivered          jsonb NULL CHECK (delivered IS NULL OR jsonb_typeof(delivered) = 'object'),
  delivered_at       timestamptz NULL,
  created_at         timestamptz NOT NULL,
  UNIQUE (parent_job_id, request_id),
  CHECK (child_job_id <> parent_job_id),
  CHECK ((delivered IS NULL) = (delivered_at IS NULL))
);
CREATE INDEX job_subtasks_parent_idx ON job_subtasks (parent_job_id, created_at);
CREATE INDEX job_subtasks_root_idx ON job_subtasks (root_job_id);

-- A sub-job's files delivered to its parent become parent inputs with their own source.
ALTER TABLE job_inputs DROP CONSTRAINT job_inputs_source_check;
ALTER TABLE job_inputs ADD CONSTRAINT job_inputs_source_check
  CHECK (source IN ('upload', 'artifact', 'upstream', 'subtask'));

-- 3. Workflow steps: why a step runs where it runs ({runtime, source, model?, tools?, machine?, notes[]}).
ALTER TABLE workflow_nodes ADD COLUMN placement jsonb NULL CHECK (placement IS NULL OR jsonb_typeof(placement) = 'object');
