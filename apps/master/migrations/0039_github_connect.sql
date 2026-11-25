-- p5-github-connect (ADR-0022, docs/design/p5-github-connect.md): GitHub App connected from the panel.
--
--  * github_app_connection: at most one panel App per master (keyRef `panel`). The private key, client secret and
--    webhook secret exist only inside `secrets` — AES-256-GCM under an HKDF sub-key of the master key
--    (SecretBox.deriveKey('github-app')), AAD bound to the App id. No column holds a plaintext secret; no API returns
--    `secrets`. key_fingerprint is the SHA-256 of the public key (what GitHub shows next to the key).
--  * github_app_installations: installations of that App, mirrored from GitHub (App JWT discovery).
--  * github_manifest_states: CSRF state of the manifest flow — SHA-256 only, single use, bound to the user, 1 h.
-- Migration number 0039: 0038 is reserved for a parallel change (machine-admin); renumber at merge if needed.

CREATE TABLE github_app_connection (
  id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  app_id           text NOT NULL CHECK (app_id ~ '^[0-9]{1,20}$'),
  slug             text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  owner_login      text NOT NULL CHECK (length(owner_login) BETWEEN 1 AND 100),
  owner_type       text NOT NULL CHECK (owner_type IN ('User', 'Organization', 'Enterprise')),
  html_url         text NOT NULL CHECK (length(html_url) <= 512),
  client_id        text NOT NULL CHECK (length(client_id) <= 100),
  permissions      jsonb NOT NULL DEFAULT '{}'::jsonb,
  secrets          bytea NOT NULL CHECK (length(secrets) BETWEEN 30 AND 32768),
  key_fingerprint  text NOT NULL CHECK (key_fingerprint ~ '^SHA256:[A-Za-z0-9+/=]{1,64}$'),
  key_created_at   timestamptz NOT NULL,
  created_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);

CREATE TABLE github_app_installations (
  installation_id      bigint PRIMARY KEY CHECK (installation_id > 0),
  app_id               text NOT NULL,
  account_login        text NOT NULL CHECK (length(account_login) BETWEEN 1 AND 100),
  account_type         text NOT NULL CHECK (length(account_type) <= 40),
  repository_selection text NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  suspended            boolean NOT NULL DEFAULT false,
  html_url             text NULL CHECK (length(html_url) <= 512),
  discovered_at        timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL
);
CREATE INDEX github_app_installations_app_idx ON github_app_installations (app_id);

CREATE TABLE github_manifest_states (
  state_hash   bytea PRIMARY KEY CHECK (length(state_hash) = 32),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Where the App is created: the owner's user account or an organization (login).
  target       text NOT NULL CHECK (target = 'user' OR target ~ '^org:[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz NULL
);
CREATE INDEX github_manifest_states_expires_idx ON github_manifest_states (expires_at);
