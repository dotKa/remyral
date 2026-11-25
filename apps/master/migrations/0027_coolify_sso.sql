-- p5-coolify-sso (docs/design/p5-coolify-sso.md): the master as a minimal OpenID Connect provider for
-- Coolify, and the forward-auth gate in front of coolify.<domain>.
-- Every secret (authorization code, access token, ticket, gate session id) is stored as its SHA-256 only.
-- The ID-token signing key lives in a secret file (OIDC_SIGNING_KEY_FILE), not here.

CREATE TABLE oidc_authorization_codes (
  code_hash             bytea PRIMARY KEY CHECK (length(code_hash) = 32),
  client_id             text NOT NULL CHECK (client_id ~ '^[a-z0-9_-]{1,64}$'),
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  redirect_uri          text NOT NULL CHECK (length(redirect_uri) <= 2048),
  scope                 text NOT NULL CHECK (length(scope) <= 512),
  nonce                 text NULL CHECK (length(nonce) <= 512),
  code_challenge        text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  code_challenge_method text NOT NULL CHECK (code_challenge_method = 'S256'),
  -- Time of the TOTP verification that authorised the request (sessions.mfa_at): the ID token's auth_time.
  auth_time             timestamptz NOT NULL,
  created_at            timestamptz NOT NULL,
  expires_at            timestamptz NOT NULL,
  -- Single use: consumed by one conditional UPDATE; a second presentation is a replay.
  used_at               timestamptz NULL
);
CREATE INDEX oidc_authorization_codes_expires_idx ON oidc_authorization_codes (expires_at);

CREATE TABLE oidc_access_tokens (
  token_hash bytea PRIMARY KEY CHECK (length(token_hash) = 32),
  -- The code the token was issued for (revoked together when that code is replayed).
  code_hash  bytea NOT NULL CHECK (length(code_hash) = 32),
  client_id  text NOT NULL,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scope      text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX oidc_access_tokens_code_idx ON oidc_access_tokens (code_hash);
CREATE INDEX oidc_access_tokens_expires_idx ON oidc_access_tokens (expires_at);

-- One-time tickets: console (agentic-ops) → gate host (coolify). Bound to the browser's state cookie.
CREATE TABLE coolify_sso_tickets (
  ticket_hash        bytea PRIMARY KEY CHECK (length(ticket_hash) = 32),
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Console session lineage: sessions.created_at survives id rotation (step-up, password change).
  console_created_at timestamptz NOT NULL,
  state_hash         bytea NOT NULL CHECK (length(state_hash) = 32),
  next_path          text NOT NULL CHECK (next_path LIKE '/%' AND length(next_path) <= 2048),
  created_at         timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  used_at            timestamptz NULL
);
CREATE INDEX coolify_sso_tickets_expires_idx ON coolify_sso_tickets (expires_at);

-- Gate sessions (cookie __Host-rcs on the gate host). Valid only while the console session lineage lives.
CREATE TABLE coolify_sso_sessions (
  id_hash            bytea PRIMARY KEY CHECK (length(id_hash) = 32),
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  console_created_at timestamptz NOT NULL,
  created_at         timestamptz NOT NULL,
  last_seen_at       timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL
);
CREATE INDEX coolify_sso_sessions_user_idx ON coolify_sso_sessions (user_id, console_created_at);
CREATE INDEX coolify_sso_sessions_expires_idx ON coolify_sso_sessions (expires_at);
-- The lineage lookup of every forward-auth decision.
CREATE INDEX IF NOT EXISTS sessions_user_created_idx ON sessions (user_id, created_at);
