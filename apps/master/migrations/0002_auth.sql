-- p1-auth (ADR-0009): local users with scrypt password hashes and mandatory TOTP, single-use recovery
-- codes, and server-side sessions referenced by a hashed opaque id.

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username         text NOT NULL UNIQUE CHECK (username ~ '^[a-z][a-z0-9_.-]{2,31}$'),
  role             text NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  -- `$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt b64>$<key b64>`: parameters travel with the hash.
  password_hash    text NOT NULL CHECK (password_hash LIKE '$scrypt$%'),
  -- AES-256-GCM ciphertext (version | iv | tag | ct), AAD `totp:<id>`. Set at enrollment start.
  totp_secret_enc  bytea NULL,
  totp_enabled     boolean NOT NULL DEFAULT false,
  totp_enrolled_at timestamptz NULL,
  -- Highest accepted TOTP time step; codes for this or earlier steps are rejected (replay).
  last_totp_step   bigint NULL,
  failed_attempts  integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until     timestamptz NULL,
  last_login_at    timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT totp_enabled OR totp_secret_enc IS NOT NULL)
);

CREATE TABLE recovery_codes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- HMAC-SHA256(pepper derived from the TOTP key file, normalised code)
  code_hash  bytea NOT NULL CHECK (length(code_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz NULL,
  UNIQUE (user_id, code_hash)
);

CREATE TABLE sessions (
  -- SHA-256 of the 256-bit random session id; the id itself only ever exists in the cookie.
  id_hash      bytea PRIMARY KEY CHECK (length(id_hash) = 32),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stage        text NOT NULL CHECK (stage IN ('mfa_pending', 'enrollment', 'full')),
  -- SHA-256 of the CSRF token (double-submit cookie + header, checked against this value).
  csrf_hash    bytea NOT NULL CHECK (length(csrf_hash) = 32),
  created_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  -- Absolute expiry (12 h for full sessions, 5 min for pending login steps).
  expires_at   timestamptz NOT NULL,
  -- Last successful TOTP verification (login or step-up); NULL after a recovery-code login.
  mfa_at       timestamptz NULL,
  mfa_failures integer NOT NULL DEFAULT 0,
  ip           text NULL,
  user_agent   text NULL
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
