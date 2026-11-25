-- p13-workflows-ui (docs/design/p13-workflows-ui.md): archived workflows. workflow_definitions stays append-only, so
-- the archive flag of a workflow (project + name, every version) lives in its own table: a row = archived (new runs and
-- new versions refused, hidden from the pickers); restoring deletes the row (both audited by the service). Additive
-- only: older code ignores the table (rollback: drop it; archived workflows become active again).

CREATE TABLE workflow_archives (
  project      text NOT NULL REFERENCES projects (id),
  name         text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]{0,63}$'),
  archived_by  text NOT NULL CHECK (length(archived_by) BETWEEN 1 AND 128),
  archived_at  timestamptz NOT NULL,
  reason       text NULL CHECK (reason IS NULL OR length(reason) <= 500),
  PRIMARY KEY (project, name)
);

-- The catalog's per-workflow run statistics (GET /workflows) read runs by project + name.
CREATE INDEX workflow_runs_project_name_idx ON workflow_runs (project, name, created_at DESC);
