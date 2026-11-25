-- p11-merge-pipeline (docs/design/p11-merge-pipeline.md, ADR-0041): master-managed integration. The master merges the
-- verified branches of a coordinator's sub-jobs (or of a workflow's upstream steps) into ONE integration branch
-- `int/<root8>` with deterministic integration jobs on a worker, opens conflict-resolution / fix jobs (bounded), runs
-- the project's verification on the result and opens ONE pull request (or offers the existing protected merge).
-- Migration number 0089 (0087 / 0088 = parallel p11 work; renumber at merge if taken). Additive only.

-- Project settings (Project → Repository → Integration): on by default for repository projects with git flow.
ALTER TABLE projects ADD COLUMN integration_mode text NOT NULL DEFAULT 'master'
  CHECK (integration_mode IN ('master', 'off'));
ALTER TABLE projects ADD COLUMN integration_order text NOT NULL DEFAULT 'dependency'
  CHECK (integration_order IN ('dependency', 'completion'));
ALTER TABLE projects ADD COLUMN integration_max_resolutions smallint NOT NULL DEFAULT 3
  CHECK (integration_max_resolutions BETWEEN 0 AND 10);
ALTER TABLE projects ADD COLUMN integration_max_fixes smallint NOT NULL DEFAULT 1
  CHECK (integration_max_fixes BETWEEN 0 AND 5);

-- Sub-job file ownership (`paths` of request_subtask): overlap warnings and the integration order.
ALTER TABLE job_subtasks ADD COLUMN paths text[] NOT NULL DEFAULT '{}' CHECK (cardinality(paths) <= 32);

-- The integration report artifact of an integration job.
ALTER TABLE job_artifacts DROP CONSTRAINT job_artifacts_kind_check;
ALTER TABLE job_artifacts ADD CONSTRAINT job_artifacts_kind_check
  CHECK (kind IN ('output', 'summary', 'site', 'integration'));

CREATE TABLE integrations (
  id                   uuid PRIMARY KEY,
  project              text NOT NULL REFERENCES projects (id),
  source               text NOT NULL CHECK (source IN ('coordinator', 'workflow')),
  -- coordinator: the root job whose sub-jobs are integrated; workflow: the run and its integrator step.
  root_job_id          uuid NULL REFERENCES jobs (id),
  run_id               uuid NULL REFERENCES workflow_runs (id),
  node_id              text NULL CHECK (node_id IS NULL OR length(node_id) BETWEEN 1 AND 200),
  branch               text NOT NULL CHECK (branch ~ '^int/[0-9a-f]{8}$'),
  target_branch        text NOT NULL CHECK (length(target_branch) BETWEEN 1 AND 255),
  repository_url       text NOT NULL CHECK (length(repository_url) BETWEEN 1 AND 2048),
  base_sha             text NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  -- Where `branch` points now (null until the first round was verified and published).
  head_sha             text NULL CHECK (head_sha IS NULL OR head_sha ~ '^[0-9a-f]{40}$'),
  -- The verified job whose attempt branch is at head_sha (its protected merge / PR merges the integration).
  head_job_id          uuid NULL REFERENCES jobs (id),
  order_mode           text NOT NULL CHECK (order_mode IN ('dependency', 'completion')),
  state                text NOT NULL CHECK (state IN ('merging', 'resolving', 'verifying', 'fixing', 'publishing',
                                                      'ready', 'merged', 'needs_human', 'failed', 'cancelled')),
  reason               text NULL CHECK (reason IS NULL OR length(reason) <= 1000),
  round                integer NOT NULL DEFAULT 0 CHECK (round >= 0),
  resolution_rounds    integer NOT NULL DEFAULT 0 CHECK (resolution_rounds >= 0),
  max_resolutions      smallint NOT NULL CHECK (max_resolutions BETWEEN 0 AND 10),
  fix_rounds           integer NOT NULL DEFAULT 0 CHECK (fix_rounds >= 0),
  max_fixes            smallint NOT NULL CHECK (max_fixes BETWEEN 0 AND 5),
  -- The job the integration waits for now (integration / resolution / fix / verifier job).
  current_job_id       uuid NULL REFERENCES jobs (id),
  verification         jsonb NULL CHECK (verification IS NULL OR jsonb_typeof(verification) = 'object'),
  pr_number            integer NULL,
  pr_url               text NULL CHECK (pr_url IS NULL OR length(pr_url) <= 2048),
  warnings             jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings) = 'array'),
  log                  jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(log) = 'array'),
  -- Who the integration acts for (the coordinator's creator / the run's starter), re-authorised for every job.
  created_by           uuid NOT NULL REFERENCES users (id),
  claimed_at           timestamptz NULL,
  merged_at            timestamptz NULL,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  CHECK ((source = 'coordinator') = (root_job_id IS NOT NULL)),
  CHECK ((source = 'workflow') = (run_id IS NOT NULL AND node_id IS NOT NULL))
);
CREATE UNIQUE INDEX integrations_root ON integrations (root_job_id) WHERE root_job_id IS NOT NULL;
CREATE UNIQUE INDEX integrations_run_node ON integrations (run_id, node_id) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX integrations_branch_open ON integrations (project, branch)
  WHERE state NOT IN ('merged', 'failed', 'cancelled');
CREATE INDEX integrations_open ON integrations (state, updated_at)
  WHERE state NOT IN ('merged', 'failed', 'cancelled', 'needs_human');

-- The branches an integration merges, in order.
CREATE TABLE integration_branches (
  integration_id       uuid NOT NULL REFERENCES integrations (id) ON DELETE CASCADE,
  position             integer NOT NULL CHECK (position BETWEEN 0 AND 1000),
  job_id               uuid NOT NULL REFERENCES jobs (id),
  title                text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  branch               text NOT NULL CHECK (length(branch) BETWEEN 1 AND 255),
  sha                  text NOT NULL CHECK (sha ~ '^[0-9a-f]{40}$'),
  paths                text[] NOT NULL DEFAULT '{}',
  state                text NOT NULL CHECK (state IN ('pending', 'merged', 'conflict', 'resolved', 'skipped')),
  merged_sha           text NULL CHECK (merged_sha IS NULL OR merged_sha ~ '^[0-9a-f]{40}$'),
  conflict_files       text[] NOT NULL DEFAULT '{}',
  -- The worker's conflict details (markers, both sides' diffs; redacted, untrusted) for the resolution prompt.
  conflict             jsonb NULL CHECK (conflict IS NULL OR jsonb_typeof(conflict) = 'object'),
  -- The verified resolution (job, branch, sha, files) the next integration round applies.
  resolution_job_id    uuid NULL REFERENCES jobs (id),
  resolution           jsonb NULL CHECK (resolution IS NULL OR jsonb_typeof(resolution) = 'object'),
  detail               text NULL CHECK (detail IS NULL OR length(detail) <= 1000),
  PRIMARY KEY (integration_id, position),
  UNIQUE (integration_id, job_id)
);

-- Every job the integration created (platform integration steps, conflict resolutions, fixes, verifiers).
CREATE TABLE integration_jobs (
  job_id               uuid PRIMARY KEY REFERENCES jobs (id),
  seq                  bigint GENERATED ALWAYS AS IDENTITY,
  integration_id       uuid NOT NULL REFERENCES integrations (id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('integrate', 'resolve', 'fix', 'verify')),
  round                integer NOT NULL CHECK (round >= 0),
  branch_position      integer NULL,
  created_at           timestamptz NOT NULL
);
CREATE INDEX integration_jobs_integration ON integration_jobs (integration_id, seq);
