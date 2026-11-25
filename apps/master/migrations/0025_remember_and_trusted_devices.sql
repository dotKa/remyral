-- p5-remember-device (ADR-0009 amendment 2026-10-14, docs/design/p5-remember-device.md): "Remember me"
-- sessions and trusted devices ("Trust this device for 30 days").

-- Every session carries its own idle timeout (seconds) and whether it is a remembered session, so lookups
-- and the opportunistic cleanup need no configuration and a configuration change never alters sessions
-- already issued. Existing rows keep today's 30 minutes.
ALTER TABLE sessions
  ADD COLUMN remember       boolean NOT NULL DEFAULT false,
  ADD COLUMN idle_timeout_s integer NOT NULL DEFAULT 1800 CHECK (idle_timeout_s > 0);

-- A browser the account holder chose to trust after a successful second factor. The token itself only
-- exists in the `__Host-rtd` cookie; the database stores its SHA-256. Rotated on every use.
CREATE TABLE trusted_devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash      bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  -- The value replaced by the last rotation: presenting it again means the token was copied (reuse).
  prev_token_hash bytea NULL CHECK (prev_token_hash IS NULL OR length(prev_token_hash) = 32),
  -- Coarse "browser on OS" label for the account holder's list; never the full user agent.
  label           text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  created_ip      text NULL CHECK (created_ip IS NULL OR length(created_ip) <= 64),
  created_at      timestamptz NOT NULL,
  last_used_at    timestamptz NOT NULL,
  last_used_ip    text NULL CHECK (last_used_ip IS NULL OR length(last_used_ip) <= 64),
  -- Fixed at creation; use never extends it.
  expires_at      timestamptz NOT NULL,
  -- users.totp_enrolled_at when the trust was granted: a reset or re-enrollment invalidates it.
  mfa_enrolled_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX trusted_devices_user_idx ON trusted_devices (user_id, created_at DESC);
CREATE INDEX trusted_devices_prev_idx ON trusted_devices (prev_token_hash) WHERE prev_token_hash IS NOT NULL;
