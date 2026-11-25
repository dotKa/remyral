-- p17-host-actions part 3 (docs/design/p17-host-actions.md §5): the off-site backup target (S3 / R2 / MinIO) chosen in
-- Ayarlar → Yedekler. The access keys are sealed like every integration secret (ADR-0028: AES-256-GCM under the HKDF
-- sub-key `ops-integrations`, AAD `backup-offsite`) and never returned, logged or audited (only a fingerprint). On a
-- remyral-ctl host they reach the backup service only through a signed `backup-offsite` request the host turns into
-- backup-config/offsite.env (root, 0600); without a host applier the operator writes that file.
CREATE TABLE backup_offsite_settings (
  id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- provider, endpoint, region, bucket, prefix, pathStyle (nothing secret).
  config           jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  secret           bytea NOT NULL,
  key_fingerprint  text NOT NULL CHECK (key_fingerprint ~ '^[0-9a-f]{16}$'),
  key_id_hint      text NOT NULL CHECK (char_length(key_id_hint) <= 8),
  last_test        jsonb NULL,
  last_test_at     timestamptz NULL,
  updated_at       timestamptz NOT NULL,
  updated_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL
);
