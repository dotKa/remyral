-- p19-project-env (docs/design/p19-project-env.md): vault credentials of kind "generic" a project gives its jobs as
-- environment variables (the credential's own `env` name). Ids only, never a value: the orchestrator adds
-- `secretRefs[env] = secret:vault-<id>` to the assignment and places the job only on machines holding the credential.
--
-- Rollback: DROP TABLE project_env_credentials; (jobs then get no project environment credentials — the state
-- before this migration).

CREATE TABLE project_env_credentials (
  project        text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  credential_id  text NOT NULL REFERENCES vault_credentials (id),
  created_by     uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL,
  PRIMARY KEY (project, credential_id)
);

CREATE INDEX project_env_credentials_credential ON project_env_credentials (credential_id);
