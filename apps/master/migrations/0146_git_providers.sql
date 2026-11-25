-- p16-git-providers (docs/design/p16-git-providers.md, ADR-0061): GitLab (gitlab.com and self-managed) and Bitbucket
-- Cloud next to GitHub and plain git.
--
--  * git_host_connections: a master-held access token per host — GitLab project / group / personal access token,
--    Bitbucket repository / project / workspace access token — with an optional separate push-only token for workers.
--    The tokens are AES-256-GCM encrypted (HKDF sub-key `git-host` of the master key, AAD bound to the row id), never
--    returned, logged or audited; only a SHA-256 fingerprint prefix is kept in clear. Expiry dates (reported by GitLab,
--    entered by the admin for Bitbucket) feed the ops-safety expiry list (item ids `githost:<id>` / `githost:<id>.push`).
--  * project_git_configs: provider 'gitlab' | 'bitbucket' with the connection the project uses.
--  * job_git: the same provider values (the record names the provider the job was verified with).
--
-- Rollback: an older master refuses to load rows with the new providers through its CHECK-free code paths only when it
-- reads them; to remove completely:
--   DELETE FROM project_git_configs WHERE provider IN ('gitlab', 'bitbucket');
--   ALTER TABLE project_git_configs DROP CONSTRAINT project_git_host_chk, DROP COLUMN host_connection_id;
--   restore the provider CHECKs of project_git_configs and job_git to ('github', 'git'); DROP TABLE git_host_connections;
-- Migration number 0146 (0145_input_uploads is the one before it on main; renumber at merge if a parallel change
-- takes it).

CREATE TABLE git_host_connections (
  id                      uuid PRIMARY KEY,
  kind                    text NOT NULL CHECK (kind IN ('gitlab', 'bitbucket')),
  label                   text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  -- GitLab: https://gitlab.com or the self-managed instance; Bitbucket: https://api.bitbucket.org.
  base_url                text NOT NULL CHECK (base_url ~ '^https://[^\s/?#@]+(/[^\s?#]*)?$' AND char_length(base_url) <= 300),
  -- Host repository URLs of this connection use (gitlab.example.com, bitbucket.org).
  web_host                text NOT NULL CHECK (web_host ~ '^[a-z0-9.-]+(:[0-9]{1,5})?$'),
  token_kind              text NOT NULL CHECK (token_kind IN ('project', 'group', 'personal', 'repository', 'workspace')),
  scope                   text NOT NULL CHECK (char_length(scope) <= 300),
  -- {"token": "...", "pushToken": "..."?} encrypted; never returned by a route.
  secrets                 bytea NOT NULL,
  token_fingerprint       text NOT NULL CHECK (token_fingerprint ~ '^[0-9a-f]{12}$'),
  push_token_fingerprint  text NULL CHECK (push_token_fingerprint IS NULL OR push_token_fingerprint ~ '^[0-9a-f]{12}$'),
  expires_at              timestamptz NULL,
  push_expires_at         timestamptz NULL,
  -- GitLab token id from GET /personal_access_tokens/self (rotation through the API); null for Bitbucket.
  remote_token_id         bigint NULL,
  token_updated_at        timestamptz NOT NULL,
  last_test               jsonb NULL CHECK (last_test IS NULL OR jsonb_typeof(last_test) = 'object'),
  last_test_at            timestamptz NULL,
  version                 integer NOT NULL CHECK (version >= 1),
  created_by              uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL,
  updated_by              uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at              timestamptz NOT NULL,
  CONSTRAINT git_host_connections_token_kind_chk CHECK (
    (kind = 'gitlab' AND token_kind IN ('project', 'group', 'personal'))
    OR (kind = 'bitbucket' AND token_kind IN ('repository', 'project', 'workspace')))
);
CREATE UNIQUE INDEX git_host_connections_label ON git_host_connections (lower(label));

ALTER TABLE project_git_configs DROP CONSTRAINT project_git_configs_provider_check;
ALTER TABLE project_git_configs ADD CONSTRAINT project_git_configs_provider_check
  CHECK (provider IN ('github', 'git', 'gitlab', 'bitbucket'));
ALTER TABLE project_git_configs
  ADD COLUMN host_connection_id uuid NULL REFERENCES git_host_connections (id) ON DELETE RESTRICT;
ALTER TABLE project_git_configs ADD CONSTRAINT project_git_host_chk
  CHECK ((provider IN ('gitlab', 'bitbucket')) = (host_connection_id IS NOT NULL));
CREATE INDEX project_git_configs_host ON project_git_configs (host_connection_id) WHERE host_connection_id IS NOT NULL;

ALTER TABLE job_git DROP CONSTRAINT job_git_provider_check;
ALTER TABLE job_git ADD CONSTRAINT job_git_provider_check
  CHECK (provider IN ('github', 'git', 'gitlab', 'bitbucket'));
