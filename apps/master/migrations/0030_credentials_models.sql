-- p5-credentials-models (ADR-0016, docs/design/p5-credentials-models.md): panel credential vault sealed end-to-end
-- to each worker, and the model catalog. The master never stores a credential value: only the X25519 vault public
-- keys the workers announce (signed by their device keys), credential METADATA and per-worker CIPHERTEXT sealed by
-- the administrator's browser. Ciphertext is deleted as soon as a version is superseded or revoked.
-- (0029 is reserved for onboarding; this migration is numbered 0030 regardless.)

-- Vault public keys announced by workers (CAPABILITIES.credentialVault.key), pinned per worker. One current key per
-- worker; earlier keys stay as history (retired_at) so the panel can show rotations.
CREATE TABLE worker_vault_keys (
  worker_id      text NOT NULL REFERENCES workers (id),
  key_id         text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_-]{22}$'),
  public_key     text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  fingerprint    text NOT NULL,
  -- The worker's own creation time and the device-key signature over the announcement (verified on receipt).
  created_at     timestamptz NOT NULL,
  signature      text NOT NULL CHECK (signature ~ '^[A-Za-z0-9_-]{86}$'),
  pinned_at      timestamptz NOT NULL,
  retired_at     timestamptz NULL,
  PRIMARY KEY (worker_id, key_id)
);
CREATE UNIQUE INDEX worker_vault_keys_current ON worker_vault_keys (worker_id) WHERE retired_at IS NULL;

-- Credential metadata (never a value). `kind` and `env` are bound into every seal (AEAD additional data), so
-- they cannot change without re-entering the value.
CREATE TABLE vault_credentials (
  id           text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,47}$'),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  kind         text NOT NULL CHECK (kind IN ('anthropic', 'openai', 'openrouter', 'gemini',
                                             'custom-openai-compatible', 'github-token', 'generic')),
  env          text NOT NULL CHECK (env ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$' AND env <> 'CLAUDE_CODE_OAUTH_TOKEN'),
  description  text NULL CHECK (description IS NULL OR length(description) <= 500),
  version      integer NOT NULL CHECK (version >= 1),
  state        text NOT NULL CHECK (state IN ('active', 'revoked')),
  created_at   timestamptz NOT NULL,
  created_by   uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL,
  updated_by   uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  revoked_at   timestamptz NULL
);

-- Per worker: the desired version and its ciphertext (sealed to `key_id`), or a pending revocation.
-- state 'active': deliver `version` until the worker reports it; 'revoked': tell the worker to delete it until it
-- reports it gone. `sealed` is NULL once revoked (ciphertext is never kept longer than needed).
CREATE TABLE vault_credential_workers (
  credential_id  text NOT NULL REFERENCES vault_credentials (id),
  worker_id      text NOT NULL REFERENCES workers (id),
  version        integer NOT NULL CHECK (version >= 1),
  key_id         text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_-]{22}$'),
  sealed         jsonb NULL CHECK (sealed IS NULL OR jsonb_typeof(sealed) = 'object'),
  sealed_digest  text NULL CHECK (sealed_digest IS NULL OR sealed_digest ~ '^[a-f0-9]{64}$'),
  state          text NOT NULL CHECK (state IN ('active', 'revoked')),
  CHECK ((state = 'active') = (sealed IS NOT NULL AND sealed_digest IS NOT NULL)),
  delivered_at   timestamptz NULL,
  -- The worker's last CREDENTIAL_STATUS / CAPABILITIES view of this credential.
  acked_version  integer NULL,
  acked_at       timestamptz NULL,
  ack_outcome    text NULL CHECK (ack_outcome IS NULL OR ack_outcome ~ '^[a-z_]{1,32}$'),
  ack_reason     text NULL CHECK (ack_reason IS NULL OR ack_reason ~ '^[a-z0-9_]{1,64}$'),
  last_used_at   timestamptz NULL,
  updated_at     timestamptz NOT NULL,
  PRIMARY KEY (credential_id, worker_id)
);
CREATE INDEX vault_credential_workers_worker ON vault_credential_workers (worker_id);

-- Model catalog (master-wide registry of model profiles; runtime policies and worker configurations reference it).
CREATE TABLE model_catalog (
  id              text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  -- @remana/protocol ModelCatalogEntryInput (validated by the service; never a credential value).
  entry           jsonb NOT NULL CHECK (jsonb_typeof(entry) = 'object'),
  enabled         boolean NOT NULL,
  version         integer NOT NULL CHECK (version >= 1),
  created_at      timestamptz NOT NULL,
  created_by      uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL,
  updated_by      uuid NULL REFERENCES users (id) ON DELETE SET NULL
);

-- Defaults per runtime, globally ('' = every project) or per project (the composer preselects them).
CREATE TABLE model_defaults (
  project     text NOT NULL DEFAULT '',
  runtime     text NOT NULL CHECK (runtime IN ('openhands', 'claude-code', 'codex', 'pi', 'opencode')),
  profile_id  text NOT NULL REFERENCES model_catalog (id),
  updated_at  timestamptz NOT NULL,
  updated_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  PRIMARY KEY (project, runtime)
);

-- A catalog change re-resolves every worker configuration that names the profile (cause 'catalog').
ALTER TABLE worker_config_versions DROP CONSTRAINT worker_config_versions_cause_check;
ALTER TABLE worker_config_versions ADD CONSTRAINT worker_config_versions_cause_check
  CHECK (cause IN ('edit', 'bulk', 'project', 'rollback', 'adopt', 'repository', 'catalog'));

-- Admins are told about vault changes and refused deliveries.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential'));

ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential'));
