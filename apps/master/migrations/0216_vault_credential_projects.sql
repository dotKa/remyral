-- p22-vault-projects (docs/design/p22-vault-projects.md; closes p18-multi-project §3 "a project allowlist on
-- credentials"): a workflow HTTP / SMTP vault credential (`http-auth`, `smtp`) may be limited to some projects.
--
--  * `projects IS NULL`  every project may reference it (the behaviour of every existing credential; unchanged).
--  * a non-empty list     only those projects: workflow save, shared-workflow slot binding, the run-time build of a
--                         function job, dispatch of that job and the assistant's credential lookups refuse it
--                         elsewhere (`credential_not_allowed_for_project`).
--
-- Project ids are not a foreign key (an array): a deleted project's id simply matches no project any more (fail
-- closed). Other kinds keep NULL (their project binding lives elsewhere: project env / repository credentials).
--
-- Additive (a nullable column). Rollback: an older master ignores the column (every credential then behaves as NULL);
-- to remove: ALTER TABLE vault_credentials DROP COLUMN projects;

ALTER TABLE vault_credentials
  ADD COLUMN projects text[] NULL
    CHECK (projects IS NULL OR cardinality(projects) BETWEEN 1 AND 200),
  ADD CONSTRAINT vault_credentials_projects_kind
    CHECK (projects IS NULL OR kind IN ('http-auth', 'smtp'));
