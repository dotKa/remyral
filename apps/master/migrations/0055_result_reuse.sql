-- p6-result-reuse (docs/design/p6-result-reuse.md): digests that find an identical earlier job before a new one is
-- dispatched, the automation / workflow-step policy "skip if an identical successful run exists within N hours"
-- (default off) and the link a skipped run or reused step records. Additive only.

-- sha256:<hex> of the normalised prompt (Unicode NFC, lower case, whitespace runs collapsed, trimmed; workflow steps
-- with their run id masked). NULL for jobs created before this migration (they are never offered for reuse).
ALTER TABLE jobs
  ADD COLUMN prompt_digest text NULL CHECK (prompt_digest IS NULL OR prompt_digest ~ '^sha256:[a-f0-9]{64}$'),
  -- Workspace jobs only: sha256:<hex> over the sorted (name, sha256) pairs of the job's input files.
  ADD COLUMN inputs_digest text NULL CHECK (inputs_digest IS NULL OR inputs_digest ~ '^sha256:[a-f0-9]{64}$');

-- The lookup: same project and prompt, finished successfully, newest first.
CREATE INDEX jobs_reuse_idx ON jobs (project, prompt_digest, state_changed_at DESC)
  WHERE state = 'SUCCEEDED' AND prompt_digest IS NOT NULL;

-- Automation policy: skip a scheduled run when an identical successful job finished within this many hours.
-- NULL = off (the default). Job targets only (enforced by the service).
ALTER TABLE automations
  ADD COLUMN reuse_within_hours integer NULL CHECK (reuse_within_hours IS NULL OR reuse_within_hours BETWEEN 1 AND 168);

-- A run skipped because of that policy links the identical job it found (state 'skipped').
ALTER TABLE automation_runs
  ADD COLUMN reused_job_id uuid NULL REFERENCES jobs (id),
  ADD CONSTRAINT automation_runs_reused_check CHECK (reused_job_id IS NULL OR state = 'skipped');

-- A workflow step whose opt-in policy reused an identical earlier job: `job_id` then names that job and
-- `reused_job_id` repeats it. The step's own job was cancelled before it ran (still listed in workflow_node_jobs).
ALTER TABLE workflow_nodes ADD COLUMN reused_job_id uuid NULL REFERENCES jobs (id);
