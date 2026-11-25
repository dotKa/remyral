-- p2-pairing / p2-heartbeat-caps (ADR-0005): workers, their device credentials and reported runtime
-- capabilities. Rows are written only through src/workers/* (WorkerStore / PgDeviceDirectory).
-- Design: docs/design/p2-transport.md.

CREATE TABLE workers (
  -- `wrk_` + 26 lower-case base32 characters (protocol Identifier).
  id                   text PRIMARY KEY CHECK (id ~ '^wrk_[a-z2-7]{26}$'),
  display_name         text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 255),
  -- ROADMAP P2 states (@remana/protocol WorkerState).
  state                text NOT NULL CHECK (state IN
                         ('pending', 'online', 'busy', 'draining', 'offline', 'quarantined', 'updating')),
  quarantine_reason    text NULL CHECK (quarantine_reason IN ('enrollment_denied', 'pairing_failed', 'revoked')),
  CHECK ((state = 'quarantined') = (quarantine_reason IS NOT NULL)),
  -- Last HELLO facts (HostFacts) and versions; untrusted, informational.
  facts                jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'object'),
  worker_version       text NOT NULL CHECK (length(worker_version) <= 64),
  protocol_version     text NULL CHECK (length(protocol_version) <= 16),
  -- Pairing (ADR-0005 §3): SHA-256 of the normalised code, kept after use so a code is single-use.
  pairing_code_hash    bytea NULL CHECK (pairing_code_hash IS NULL OR length(pairing_code_hash) = 32),
  pairing_expires_at   timestamptz NULL,
  pairing_failures     integer NOT NULL DEFAULT 0 CHECK (pairing_failures >= 0),
  approved_at          timestamptz NULL,
  approved_by          uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  denied_at            timestamptz NULL,
  denied_by            uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  revoked_at           timestamptz NULL,
  revoked_by           uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  -- Admin intent; survives reconnects (the master re-sends DRAIN on every session).
  drain_requested_at   timestamptz NULL,
  drain_reason         text NULL CHECK (length(drain_reason) <= 500),
  -- Connectivity (p2-heartbeat-caps).
  connected_at         timestamptz NULL,
  last_seen_at         timestamptz NULL,
  last_ip              text NULL CHECK (length(last_ip) <= 100),
  running_jobs         integer NOT NULL DEFAULT 0 CHECK (running_jobs >= 0),
  -- Last HEARTBEAT load figures {cpuPercent, memoryFreeBytes, diskFreeBytes}.
  load                 jsonb NULL,
  -- Last CAPABILITIES summary (per-runtime rows live in worker_runtimes).
  sandbox_profiles     jsonb NOT NULL DEFAULT '[]'::jsonb,
  tools                jsonb NOT NULL DEFAULT '[]'::jsonb,
  max_parallel_jobs    integer NULL CHECK (max_parallel_jobs BETWEEN 0 AND 64),
  capabilities_at      timestamptz NULL,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL
);

CREATE UNIQUE INDEX workers_pairing_code_hash_idx ON workers (pairing_code_hash) WHERE pairing_code_hash IS NOT NULL;
CREATE INDEX workers_state_idx ON workers (state, last_seen_at);

CREATE TABLE worker_credentials (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  worker_id           text NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  -- Raw Ed25519 public key, 43-char base64url (protocol Ed25519PublicKey).
  public_key          text NOT NULL UNIQUE CHECK (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  fingerprint         text NOT NULL CHECK (fingerprint ~ '^SHA256:([0-9A-F]{4}-){15}[0-9A-F]{4}$'),
  -- pending: pairing or rotation awaiting approval; active: the one key that may authenticate;
  -- superseded: replaced by a rotation; revoked: worker revoked; denied: enrollment/rotation denied.
  status              text NOT NULL CHECK (status IN ('pending', 'active', 'superseded', 'revoked', 'denied')),
  created_at          timestamptz NOT NULL,
  activated_at        timestamptz NULL,
  retired_at          timestamptz NULL,
  -- Rotation (p2-identity-rotation): the credential this key replaces, and the old key's signature over
  -- the rotation statement (verifiable later from the audit trail).
  rotated_from        bigint NULL REFERENCES worker_credentials (id),
  rotation_signature  text NULL CHECK (rotation_signature IS NULL OR rotation_signature ~ '^[A-Za-z0-9_-]{86}$')
);

CREATE UNIQUE INDEX worker_credentials_one_active_idx ON worker_credentials (worker_id) WHERE status = 'active';
CREATE INDEX worker_credentials_worker_idx ON worker_credentials (worker_id, created_at);

-- Reported runtimes, one row per (worker, runtime, version, os, arch); `present` is false once a newer
-- CAPABILITIES report no longer lists it (history is kept for compatibility evidence).
CREATE TABLE worker_runtimes (
  worker_id          text NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  runtime            text NOT NULL CHECK (runtime IN ('openhands', 'claude-code', 'codex', 'pi', 'opencode')),
  version            text NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
  os                 text NOT NULL CHECK (os IN ('darwin', 'linux', 'win32')),
  arch               text NOT NULL CHECK (arch IN ('x64', 'arm64')),
  installed          boolean NOT NULL,
  authenticated      text NOT NULL CHECK (authenticated IN ('yes', 'no', 'unknown')),
  pinned_version     text NULL CHECK (length(pinned_version) <= 64),
  pin_status         text NOT NULL CHECK (pin_status IN ('match', 'mismatch', 'unknown', 'not-installed')),
  capabilities       jsonb NOT NULL CHECK (jsonb_typeof(capabilities) = 'object'),
  present            boolean NOT NULL DEFAULT true,
  first_reported_at  timestamptz NOT NULL,
  last_reported_at   timestamptz NOT NULL,
  PRIMARY KEY (worker_id, runtime, version, os, arch)
);
