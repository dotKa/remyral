-- p5-rbac-api (ADR-0009 roles, threat model T-CP-3): projects as first-class records, per-project
-- memberships for operator/viewer accounts, and account disabling. Design: docs/design/p5-rbac.md.
--
-- Roles: `users.role` stays the account role. owner/admin are global (every project). operator/viewer are
-- per project: they see a project only through a `project_memberships` row, and their effective role there
-- is the lower of the membership role and the account role (the account role is a ceiling).

CREATE TABLE projects (
  -- Same identifier format as jobs.project / project_policies.project / context namespaces, so existing
  -- rows keep referring to projects by id without a data rewrite.
  id         text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- NULL for projects registered by this migration from pre-existing data.
  created_by uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE project_memberships (
  project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('operator', 'viewer')),
  granted_by uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX project_memberships_user_idx ON project_memberships (user_id);

-- Disabled accounts cannot log in and lose every session; rows are kept (audit references them).
ALTER TABLE users
  ADD COLUMN disabled_at timestamptz NULL,
  ADD COLUMN created_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL;

-- Register every project identifier already in use so memberships can be granted for existing data.
-- Unregistered identifiers that appear later (e.g. a job created for a new project) stay visible to
-- owner/admin only until an admin registers the project.
INSERT INTO projects (id, name, created_at)
SELECT p, p, now()
  FROM (
    SELECT project AS p FROM jobs
    UNION SELECT project FROM project_policies
    UNION SELECT project FROM context_doc_grants
    UNION SELECT substr(namespace, length('project:') + 1) FROM context_documents
     WHERE namespace LIKE 'project:%'
    UNION SELECT project FROM usage_records
    UNION SELECT scope_value FROM usage_budgets WHERE scope_type = 'project'
  ) existing
 WHERE p ~ '^[A-Za-z0-9_.:-]{1,128}$'
ON CONFLICT (id) DO NOTHING;
