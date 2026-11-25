-- p15-github-create-repo (docs/design/p15-github-create-repo.md): Remana opens a private GitHub repository itself and
-- links it to a project. Additive only.
--
--  * github_user_tokens: a GitHub account the master may act for when the App installation cannot (a personal account:
--    GitHub creates repositories for a user only with a user token). Either a GitHub App user access token (kind
--    app_user, from "GitHub hesabını yetkilendir"; refreshed when it expires) or a fine-grained personal access token
--    (kind pat, fallback). The token(s) exist only inside `secrets` — AES-256-GCM under the HKDF sub-key
--    `github-user-token` of the master key, AAD bound to the row id. No API returns `secrets`; they are never logged or
--    audited. One row per GitHub account (login, case-insensitive).
--  * github_user_auth_states: CSRF state of the authorization redirect — SHA-256 only, single use, user-bound, 15 min.
--  * github_repo_creations: what Remana created (owner/name, how, linked project, warnings) — idempotency of a retried
--    request (UNIQUE idempotency_key) and history. No secret.
--  * github_app_installations.permissions: the permissions the installation accepted (GET /app/installations), so the
--    console knows whether an organization installation may create repositories (administration: write).
--  * chat_drafts.kind + github_repo (the assistant's create_repository).
--
-- Rollback: the old master ignores the tables and the column; drop them by hand only after a rollback is final:
--   DROP TABLE github_repo_creations, github_user_auth_states, github_user_tokens;
--   ALTER TABLE github_app_installations DROP COLUMN permissions;
-- Migration number 0129 (given in the brief); renumber at merge if needed.

CREATE TABLE github_user_tokens (
  id                  uuid PRIMARY KEY,
  kind                text NOT NULL CHECK (kind IN ('app_user', 'pat')),
  github_login        text NOT NULL CHECK (github_login ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  github_user_id      bigint NOT NULL CHECK (github_user_id > 0),
  -- app_user: the App the token belongs to (a token of a disconnected / replaced App is unusable).
  app_id              text NULL CHECK (app_id IS NULL OR app_id ~ '^[0-9]{1,20}$'),
  secrets             bytea NOT NULL CHECK (length(secrets) BETWEEN 30 AND 16384),
  -- NULL: the token does not expire (App with expiring user tokens switched off, or a PAT without expiry).
  access_expires_at   timestamptz NULL,
  refresh_expires_at  timestamptz NULL,
  created_by          uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  last_used_at        timestamptz NULL,
  -- Last refresh / use failure (a short code such as refresh_failed), cleared on success.
  last_error          text NULL CHECK (last_error IS NULL OR length(last_error) <= 200),
  CHECK (kind <> 'app_user' OR app_id IS NOT NULL)
);
CREATE UNIQUE INDEX github_user_tokens_login ON github_user_tokens (lower(github_login));

CREATE TABLE github_user_auth_states (
  state_hash   bytea PRIMARY KEY CHECK (length(state_hash) = 32),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz NULL
);
CREATE INDEX github_user_auth_states_expires_idx ON github_user_auth_states (expires_at);

CREATE TABLE github_repo_creations (
  id               uuid PRIMARY KEY,
  idempotency_key  text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  owner            text NOT NULL CHECK (owner ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  name             text NOT NULL CHECK (name ~ '^[A-Za-z0-9._-]{1,100}$'),
  owner_type       text NOT NULL CHECK (owner_type IN ('User', 'Organization')),
  -- installation: the App installation token (organization); user_token / pat: a github_user_tokens row.
  method           text NOT NULL CHECK (method IN ('installation', 'app_user', 'pat')),
  private          boolean NOT NULL,
  installation_id  bigint NULL,
  repo_id          bigint NULL,
  html_url         text NULL CHECK (html_url IS NULL OR length(html_url) <= 512),
  clone_url        text NULL CHECK (clone_url IS NULL OR length(clone_url) <= 512),
  default_branch   text NULL CHECK (default_branch IS NULL OR length(default_branch) <= 200),
  project          text NULL REFERENCES projects (id) ON DELETE SET NULL,
  state            text NOT NULL CHECK (state IN ('creating', 'created', 'failed')),
  warnings         jsonb NOT NULL DEFAULT '[]'::jsonb,
  error            text NULL CHECK (error IS NULL OR length(error) <= 500),
  via              text NOT NULL CHECK (via IN ('api', 'chat')),
  created_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);
CREATE INDEX github_repo_creations_project ON github_repo_creations (project, created_at DESC);

ALTER TABLE github_app_installations ADD COLUMN permissions jsonb NULL;

-- Chat draft kind `github_repo`, appended to whatever the constraint allows now (same helper as 0123).
CREATE FUNCTION pg_temp.widen_check_0129(t text, c text, col text, extra text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  def text;
  vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = c AND conrelid = t::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint % not found', c;
  END IF;
  IF def ~ '\{' THEN
    vals := string_to_array(substring(def from '\{([^}]*)\}'), ',');
  ELSE
    SELECT array_agg(DISTINCT m[1]) INTO vals FROM regexp_matches(def, '''([A-Za-z0-9_.:-]+)''', 'g') AS m;
  END IF;
  IF coalesce(array_length(vals, 1), 0) < 2 THEN
    RAISE EXCEPTION 'could not read the values of %', c;
  END IF;
  vals := vals || extra;
  SELECT array_agg(DISTINCT v ORDER BY v) INTO vals FROM unnest(vals) AS v;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I = ANY (%L::text[]))', t, c, col, vals);
END
$$;

SELECT pg_temp.widen_check_0129('chat_drafts', 'chat_drafts_kind_check', 'kind', ARRAY['github_repo']);
