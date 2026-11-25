-- p5-git-identity (docs/design/p5-git-identity.md): the git commit identity (author and committer) of agent work.
--
--  * projects.git_author_name / git_author_email: the project's identity, both set or both NULL (inherit). Changed
--    through PUT /projects/:id/git-identity (project admin + step-up), audited `project.git_identity.update`.
--  * git_identity_default: at most one workspace-wide default (Settings → Integrations), used when a project sets
--    none. Changed through PUT /settings/git-identity (admin + step-up), audited `settings.git_identity.update`.
--  Without either the master resolves to Remana Agent <agent@remana.invalid> (unchanged behaviour). The resolved
--  identity travels in ASSIGN_JOB.gitIdentity; the worker uses it for the publish commit and the runtime env.
--  The checks mirror @remana/protocol `gitIdentityProblem` (the API validates first, with readable messages).
-- Migration number 0040: renumber at merge if a parallel change took it.

ALTER TABLE projects
  ADD COLUMN git_author_name text NULL
    CHECK (git_author_name IS NULL OR (length(git_author_name) BETWEEN 1 AND 100
                                       AND git_author_name !~ '[[:cntrl:]<>]')),
  ADD COLUMN git_author_email text NULL
    CHECK (git_author_email IS NULL OR (length(git_author_email) BETWEEN 3 AND 254
                                        AND git_author_email ~ '^[^[:space:][:cntrl:]@<>]+@[^[:space:][:cntrl:]@<>]+$')),
  ADD COLUMN git_identity_updated_by uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN git_identity_updated_at timestamptz NULL,
  ADD CONSTRAINT projects_git_identity_pair
    CHECK ((git_author_name IS NULL) = (git_author_email IS NULL));

CREATE TABLE git_identity_default (
  id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100 AND name !~ '[[:cntrl:]<>]'),
  email       text NOT NULL CHECK (length(email) BETWEEN 3 AND 254
                                   AND email ~ '^[^[:space:][:cntrl:]@<>]+@[^[:space:][:cntrl:]@<>]+$'),
  updated_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL
);
