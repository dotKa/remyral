-- p14-repo-egress (docs/design/p14-repo-egress.md): the network egress policy of a repository project's jobs, the same
-- model as a research workspace (`project_workspaces.egress`):
--   none       model provider APIs only (the worker's sandbox.egressAllow) + the job's MCP hosts — the behaviour before
--              this table existed, and the default of every project without a row;
--   allowlist  + the hosts of `presets` (package registries, GitHub / GitLab; expanded by the master from
--              packages/protocol/src/repo-egress.ts) + `hosts`;
--   web        + any public host on 443.
-- LAN / private / loopback / link-local / CGNAT / metadata addresses are refused by the worker's egress proxy in every
-- mode. Rows are written only through src/repo-egress/* (project admin + always-fresh step-up, audited
-- `project.repo_egress.update`). Additive only (rollback: leave the table; older code never reads it). Migration
-- number 0117 (given in the brief); renumber at merge if needed.

CREATE TABLE project_repo_egress (
  project     text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  mode        text NOT NULL CHECK (mode IN ('none', 'allowlist', 'web')),
  presets     text[] NOT NULL DEFAULT '{}'
                CHECK (presets <@ ARRAY['npm', 'pypi', 'crates', 'go', 'maven', 'github', 'gitlab']::text[]),
  -- `host` or `host:port` (EgressHost shape, public DNS names only; checked by the master before every write).
  hosts       text[] NOT NULL DEFAULT '{}' CHECK (cardinality(hosts) <= 48),
  updated_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL
);
