-- p4-git-flow (ADR-0004 §3, ADR-0006 §3, ADR-0010; threat model T-INJ-2/3, T-WRK-2, T-OPS-1):
-- per-project git provider configuration, the master's independent view of each job's changes, and
-- merge/discard requests that execute only after a human approval.
-- Design: docs/design/p4-git-flow.md. Rows are written only through src/gitflow.

---------------------------------------------------------------------------------------------------
-- Project git configuration (one row per project; optimistic `version`). No secrets: the GitHub App
-- private key stays in a file on the master; `github_key_ref` only names which configured key to use.
---------------------------------------------------------------------------------------------------

CREATE TABLE project_git_configs (
  project                text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  version                integer NOT NULL CHECK (version >= 1),
  provider               text NOT NULL CHECK (provider IN ('github', 'git')),
  -- Canonical https/ssh URL; jobs of the project must name the same repository.
  repository_url         text NOT NULL CHECK (length(repository_url) BETWEEN 8 AND 512),
  base_branch            text NOT NULL CHECK (base_branch ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$'),
  merge_method           text NOT NULL CHECK (merge_method IN ('merge', 'squash')),
  require_ci             boolean NOT NULL,
  ci_timeout_sec         integer NOT NULL CHECK (ci_timeout_sec BETWEEN 60 AND 172800),
  github_app_id          text NULL CHECK (github_app_id IS NULL OR github_app_id ~ '^[A-Za-z0-9.]{1,64}$'),
  github_installation_id bigint NULL CHECK (github_installation_id IS NULL OR github_installation_id > 0),
  github_key_ref         text NULL CHECK (github_key_ref IS NULL OR github_key_ref ~ '^[a-z0-9_-]{1,64}$'),
  updated_by             uuid NOT NULL REFERENCES users (id),
  updated_at             timestamptz NOT NULL,
  CONSTRAINT project_git_github_chk CHECK (
    (provider = 'github') = (github_installation_id IS NOT NULL AND github_app_id IS NOT NULL
                              AND github_key_ref IS NOT NULL))
);

---------------------------------------------------------------------------------------------------
-- The master's view of a job's changes (verified on the remote, never taken from the worker's claim).
---------------------------------------------------------------------------------------------------

CREATE TABLE job_git (
  job_id              uuid PRIMARY KEY REFERENCES jobs (id),
  project             text NOT NULL,
  provider            text NOT NULL CHECK (provider IN ('github', 'git')),
  target_branch       text NOT NULL CHECK (length(target_branch) BETWEEN 1 AND 255),
  -- Head of the target branch (or the job's base sha) captured before the first attempt was assigned.
  base_sha            text NULL CHECK (base_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  base_captured_at    timestamptz NULL,
  -- Verification of the current attempt (VERIFYING stage).
  attempt_id          uuid NULL,
  epoch               integer NULL CHECK (epoch >= 0),
  branch              text NULL CHECK (length(branch) <= 300),
  head_sha            text NULL CHECK (head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  verification        text NOT NULL DEFAULT 'pending' CHECK (verification IN ('pending', 'passed', 'failed')),
  verification_reason text NULL CHECK (length(verification_reason) <= 1000),
  verified_at         timestamptz NULL,
  -- {commits:[{sha, subject, author, date}], files:[{path, status, additions, deletions}], totals, truncated}
  changes             jsonb NULL CHECK (changes IS NULL OR jsonb_typeof(changes) = 'object'),
  -- Paths that need extra review (CI config, dependency manifests; T-INJ-3).
  flags               jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(flags) = 'array'),
  -- Test merge of head onto the current target branch.
  merge_state         text NULL CHECK (merge_state IN ('clean', 'conflicts', 'base_moved', 'unknown')),
  -- {files, baseSha, headSha, headCommits, baseCommits, reason}
  merge_check         jsonb NULL CHECK (merge_check IS NULL OR jsonb_typeof(merge_check) = 'object'),
  merge_checked_at    timestamptz NULL,
  pr_number           integer NULL CHECK (pr_number > 0),
  pr_url              text NULL CHECK (length(pr_url) <= 512),
  ci_state            text NULL CHECK (ci_state IN ('none', 'pending', 'success', 'failure', 'timed_out', 'unavailable')),
  ci                  jsonb NULL CHECK (ci IS NULL OR jsonb_typeof(ci) = 'object'),
  ci_checked_at       timestamptz NULL,
  merged_sha          text NULL CHECK (merged_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  merged_at           timestamptz NULL,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL
);

CREATE INDEX job_git_project_idx ON job_git (project, created_at);

---------------------------------------------------------------------------------------------------
-- Merge / leave-open / discard requests. Each is bound to one approval request (gate); it executes only
-- after the approval closed as approved, with the head sha it was requested for (sha guard).
---------------------------------------------------------------------------------------------------

CREATE TABLE git_merge_requests (
  id                  uuid PRIMARY KEY,
  job_id              uuid NOT NULL REFERENCES jobs (id),
  approval_request_id uuid NOT NULL UNIQUE REFERENCES approval_requests (id),
  mode                text NOT NULL CHECK (mode IN ('merge', 'leave_open', 'discard')),
  head_sha            text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  base_sha            text NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  target_branch       text NOT NULL CHECK (length(target_branch) BETWEEN 1 AND 255),
  method              text NOT NULL CHECK (method IN ('merge', 'squash')),
  requested_by        uuid NOT NULL REFERENCES users (id),
  reason              text NULL CHECK (length(reason) <= 1000),
  status              text NOT NULL CHECK (status IN ('pending', 'approved', 'executing', 'merged',
                        'left_open', 'discarded', 'refused', 'denied', 'expired', 'cancelled')),
  approved_by         uuid NULL REFERENCES users (id),
  approved_at         timestamptz NULL,
  result_reason       text NULL CHECK (length(result_reason) <= 1000),
  merge_sha           text NULL CHECK (merge_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  executed_at         timestamptz NULL,
  claimed_at          timestamptz NULL,
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  CONSTRAINT git_merge_requests_approved_chk CHECK (
    status IN ('pending', 'denied', 'expired', 'cancelled') OR approved_by IS NOT NULL)
);

-- At most one open request per job (pending, approved or executing).
CREATE UNIQUE INDEX git_merge_requests_open_idx ON git_merge_requests (job_id)
  WHERE status IN ('pending', 'approved', 'executing');
CREATE INDEX git_merge_requests_job_idx ON git_merge_requests (job_id, created_at);
