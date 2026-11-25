-- p2-signed-updates (threat model T-SUP-2, ADR-0011): signed worker releases, update channels with a
-- rollout percentage, per-worker targets and update attempts with their outcome.
-- Rows are written only through src/releases/*. Design: docs/design/p2-signed-updates.md.
--
-- The master stores and serves releases; it cannot sign them. `manifest` holds the exact signed bytes
-- and `signature` the detached release-key signature, both verified against RELEASE_PUBLIC_KEYS before a
-- row is inserted. Workers verify again with their pinned key, so a row that is altered here is refused.

CREATE TABLE worker_releases (
  version           text PRIMARY KEY CHECK (
                      length(version) <= 64
                      AND version ~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(-[0-9A-Za-z.-]+)?$'),
  -- The channel the release key holder signed the build for (manifest.channel).
  channel           text NOT NULL CHECK (channel IN ('stable', 'canary')),
  manifest          bytea NOT NULL CHECK (length(manifest) BETWEEN 1 AND 8192),
  -- {keyId, signature} (protocol ReleaseSignature).
  signature         jsonb NOT NULL CHECK (jsonb_typeof(signature) = 'object'),
  key_id            text NOT NULL CHECK (key_id ~ '^[a-f0-9]{16}$'),
  sha256            text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes        integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 33554432),
  protocol_versions jsonb NOT NULL CHECK (jsonb_typeof(protocol_versions) = 'array'),
  min_node          text NOT NULL CHECK (min_node ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'),
  artifact          bytea NOT NULL,
  CHECK (length(artifact) = size_bytes),
  built_at          timestamptz NOT NULL,
  uploaded_at       timestamptz NOT NULL,
  uploaded_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL
);

-- What each channel currently offers, and to which share of its workers (deterministic per worker and
-- version: sha256(version, worker id) mod 100 < rollout_percent).
CREATE TABLE worker_release_channels (
  channel          text PRIMARY KEY CHECK (channel IN ('stable', 'canary')),
  version          text NOT NULL REFERENCES worker_releases (version),
  rollout_percent  integer NOT NULL CHECK (rollout_percent BETWEEN 0 AND 100),
  updated_at       timestamptz NOT NULL,
  updated_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL
);

-- Per-worker update intent. No row = channel `stable`. A `target_version` pins the worker to exactly that
-- version (channel promotions no longer apply) until the pin is cleared.
CREATE TABLE worker_update_targets (
  worker_id       text PRIMARY KEY REFERENCES workers (id) ON DELETE CASCADE,
  channel         text NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable', 'canary')),
  target_version  text NULL REFERENCES worker_releases (version),
  -- Explicit administrator rollback: the only way a worker is offered a lower version.
  rollback        boolean NOT NULL DEFAULT false,
  -- Activate even while jobs run (otherwise the worker drains first).
  force           boolean NOT NULL DEFAULT false,
  CHECK (target_version IS NOT NULL OR (NOT rollback AND NOT force)),
  requested_at    timestamptz NOT NULL,
  requested_by    uuid NULL REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE worker_update_attempts (
  id                uuid PRIMARY KEY,
  worker_id         text NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  from_version      text NOT NULL CHECK (length(from_version) BETWEEN 1 AND 64),
  to_version        text NOT NULL REFERENCES worker_releases (version),
  source            text NOT NULL CHECK (source IN ('channel', 'target')),
  rollback          boolean NOT NULL,
  force             boolean NOT NULL,
  -- offered → downloading → (deferred) → activating → succeeded | rolled_back | failed | refused;
  -- superseded: replaced by a newer offer before it finished; timed_out: no outcome in time.
  status            text NOT NULL CHECK (status IN ('offered', 'downloading', 'deferred', 'activating',
                      'succeeded', 'rolled_back', 'failed', 'refused', 'superseded', 'timed_out')),
  reason            text NULL CHECK (reason ~ '^[a-z0-9_]{1,64}$'),
  detail            text NULL CHECK (length(detail) <= 500),
  -- SHA-256 of the single-worker, single-release download token (never stored in clear).
  token_hash        bytea NULL CHECK (token_hash IS NULL OR length(token_hash) = 32),
  token_expires_at  timestamptz NULL,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  finished_at       timestamptz NULL
);

CREATE UNIQUE INDEX worker_update_attempts_token_idx ON worker_update_attempts (token_hash)
  WHERE token_hash IS NOT NULL;
CREATE INDEX worker_update_attempts_worker_idx ON worker_update_attempts (worker_id, created_at DESC);
CREATE INDEX worker_update_attempts_created_idx ON worker_update_attempts (created_at DESC);
-- At most one open attempt per worker.
CREATE UNIQUE INDEX worker_update_attempts_open_idx ON worker_update_attempts (worker_id)
  WHERE status IN ('offered', 'downloading', 'deferred', 'activating');
