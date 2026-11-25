-- p17-object-storage (docs/design/p17-object-storage.md, ADR-0064): job outputs and other large blobs live in object
-- storage (S3 / Cloudflare R2 / MinIO) or, when none is configured, on the master's local disk (a volume) — never in
-- Postgres for new blobs. Rows keep their metadata (name, type, size, SHA-256) and point at the blob by key.
--
--  * blob_objects: one row per stored blob (key, kind, where it lives, size, SHA-256). Written before the bytes are
--    put (autocommit), so a blob whose owning row never committed is found and removed by the blob GC.
--  * blob_key on job_artifacts, job_inputs, site_upload_files, worker_releases, worker_release_installer_kits: the
--    row's blob (NULL: the bytes are still in the row's bytea column, or the content was pruned). `remyral-master
--    blobs:migrate` copies existing bytea content into the store, verifies it and then NULLs the bytea column.
--  * object_storage_settings: Settings → Integrations → Storage (provider, endpoint, bucket, …; the access keys only in
--    `secret`, AES-256-GCM under the HKDF sub-key `ops-integrations`, AAD `object-storage`) and the owner's limits.
--  * blob_uploads: master-issued upload grants of `blob-upload-v1` workers (one key, one size, one SHA-256).
--  * blob_share_links: time-limited, revocable share links of a job output (only the SHA-256 of the token is stored).
--
-- Additive (columns NULL, constraints relaxed to "bytea or blob"). Rollback: an older master ignores the new tables
-- and columns but cannot read rows whose content moved to the store — run `blobs:migrate --to-db` first (design note
-- §9), or keep this release.

CREATE TABLE blob_objects (
  key         text PRIMARY KEY CHECK (
                key ~ '^(artifacts|inputs|site-uploads|releases|kits)/[A-Za-z0-9][A-Za-z0-9._-]{0,127}(/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,4}$'),
  kind        text NOT NULL CHECK (kind IN ('artifact', 'input', 'site-upload', 'release', 'kit')),
  -- local: the master's blob directory; s3: the bucket below (endpoint + bucket + prefix at write time).
  location    text NOT NULL CHECK (location IN ('local', 's3')),
  store_ref   text NULL CHECK (store_ref IS NULL OR length(store_ref) <= 600),
  size_bytes  bigint NOT NULL CHECK (size_bytes >= 0),
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL,
  verified_at timestamptz NULL
);
CREATE INDEX blob_objects_created_idx ON blob_objects (created_at);
CREATE INDEX blob_objects_location_idx ON blob_objects (location, kind);

-- job_artifacts: a row's content is the bytea (legacy / not yet migrated) or a blob; pruned rows have neither.
ALTER TABLE job_artifacts ADD COLUMN blob_key text NULL REFERENCES blob_objects (key) ON DELETE RESTRICT;
ALTER TABLE job_artifacts DROP CONSTRAINT job_artifacts_pruned_check;
ALTER TABLE job_artifacts ADD CONSTRAINT job_artifacts_pruned_check
  CHECK ((content IS NULL AND blob_key IS NULL) = (pruned_at IS NOT NULL) AND (pruned_at IS NULL) = (pruned_reason IS NULL));
ALTER TABLE job_artifacts ADD CONSTRAINT job_artifacts_one_store_check CHECK (content IS NULL OR blob_key IS NULL);
-- Sizes: bytea content keeps the old bounds (5 MiB; app packages 80 MiB); blob-backed outputs are bounded by the
-- owner's per-file limit (≤ 2 GiB − 1, the integer column).
ALTER TABLE job_artifacts DROP CONSTRAINT job_artifacts_size_bytes_check;
ALTER TABLE job_artifacts ADD CONSTRAINT job_artifacts_size_bytes_check
  CHECK (size_bytes >= 0 AND (content IS NULL OR size_bytes <= 83886080));
CREATE INDEX job_artifacts_blob_idx ON job_artifacts (blob_key) WHERE blob_key IS NOT NULL;

ALTER TABLE job_inputs ADD COLUMN blob_key text NULL REFERENCES blob_objects (key) ON DELETE RESTRICT;
ALTER TABLE job_inputs DROP CONSTRAINT job_inputs_pruned_check;
ALTER TABLE job_inputs ADD CONSTRAINT job_inputs_pruned_check
  CHECK ((content IS NULL AND blob_key IS NULL) = (pruned_at IS NOT NULL) AND (pruned_at IS NULL) = (pruned_reason IS NULL));
ALTER TABLE job_inputs ADD CONSTRAINT job_inputs_one_store_check CHECK (content IS NULL OR blob_key IS NULL);
CREATE INDEX job_inputs_blob_idx ON job_inputs (blob_key) WHERE blob_key IS NOT NULL;

ALTER TABLE site_upload_files ALTER COLUMN content DROP NOT NULL;
ALTER TABLE site_upload_files ADD COLUMN blob_key text NULL REFERENCES blob_objects (key) ON DELETE RESTRICT;
ALTER TABLE site_upload_files ADD CONSTRAINT site_upload_files_store_check
  CHECK ((content IS NULL) <> (blob_key IS NULL));
CREATE INDEX site_upload_files_blob_idx ON site_upload_files (blob_key) WHERE blob_key IS NOT NULL;

ALTER TABLE worker_releases ALTER COLUMN artifact DROP NOT NULL;
ALTER TABLE worker_releases ADD COLUMN blob_key text NULL REFERENCES blob_objects (key) ON DELETE RESTRICT;
ALTER TABLE worker_releases ADD CONSTRAINT worker_releases_store_check
  CHECK ((artifact IS NULL) <> (blob_key IS NULL));
CREATE INDEX worker_releases_blob_idx ON worker_releases (blob_key) WHERE blob_key IS NOT NULL;

ALTER TABLE worker_release_installer_kits ALTER COLUMN content DROP NOT NULL;
ALTER TABLE worker_release_installer_kits ADD COLUMN blob_key text NULL REFERENCES blob_objects (key) ON DELETE RESTRICT;
ALTER TABLE worker_release_installer_kits ADD CONSTRAINT worker_release_installer_kits_store_check
  CHECK ((content IS NULL) <> (blob_key IS NULL));
CREATE INDEX worker_release_installer_kits_blob_idx ON worker_release_installer_kits (blob_key)
  WHERE blob_key IS NOT NULL;

-- Settings → Integrations → Storage (one row). `mode` local: the master's blob directory; s3: the bucket in `config`.
CREATE TABLE object_storage_settings (
  id              smallint PRIMARY KEY CHECK (id = 1),
  mode            text NOT NULL CHECK (mode IN ('local', 's3')),
  -- {provider, endpoint, region, bucket, pathStyle, prefix, sse, kmsKeyId, keyIdHint} (no secret).
  config          jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  secret          bytea NULL,
  key_fingerprint text NULL CHECK (key_fingerprint IS NULL OR key_fingerprint ~ '^[0-9a-f]{16}$'),
  CHECK (mode = 'local' OR (secret IS NOT NULL AND key_fingerprint IS NOT NULL)),
  -- {maxFileBytes, maxJobBytes, thresholdBytes, downloadTtlSeconds, shareMaxDays} (validated by the master).
  limits          jsonb NOT NULL CHECK (jsonb_typeof(limits) = 'object'),
  last_test       jsonb NULL CHECK (last_test IS NULL OR jsonb_typeof(last_test) = 'object'),
  last_test_at    timestamptz NULL,
  updated_by      uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL
);
INSERT INTO object_storage_settings (id, mode, config, limits, updated_at)
VALUES (1, 'local', '{}'::jsonb, '{}'::jsonb, now())
ON CONFLICT (id) DO NOTHING;

-- Upload grants of blob-upload-v1 workers: exactly one key, one size and one SHA-256, for one attempt of one job.
CREATE TABLE blob_uploads (
  id                 uuid PRIMARY KEY,
  job_id             uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  attempt_id         uuid NOT NULL,
  epoch              integer NOT NULL CHECK (epoch >= 0),
  worker_id          text NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 128),
  artifact_id        text NOT NULL CHECK (artifact_id ~ '^ws-[a-z0-9-]{1,100}$'),
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  media_type         text NOT NULL CHECK (media_type ~ '^[a-z]+/[A-Za-z0-9.+-]+$'),
  size_bytes         bigint NOT NULL CHECK (size_bytes >= 0),
  sha256             text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  key                text NOT NULL REFERENCES blob_objects (key) ON DELETE CASCADE,
  location           text NOT NULL CHECK (location IN ('local', 's3')),
  -- s3 multipart: the provider's upload id and the declared parts [{sizeBytes, sha256}].
  multipart_id       text NULL CHECK (multipart_id IS NULL OR length(multipart_id) <= 1024),
  parts              jsonb NULL CHECK (parts IS NULL OR jsonb_typeof(parts) = 'array'),
  -- local: SHA-256 of the one-time bearer token of the master's upload endpoint (never stored in clear).
  token_hash         bytea NULL CHECK (token_hash IS NULL OR length(token_hash) = 32),
  state              text NOT NULL CHECK (state IN ('granted', 'verifying', 'verified', 'committed', 'failed', 'expired')),
  reason             text NULL CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,64}$'),
  created_at         timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  verified_at        timestamptz NULL,
  committed_at       timestamptz NULL,
  UNIQUE (attempt_id, artifact_id)
);
CREATE UNIQUE INDEX blob_uploads_token_idx ON blob_uploads (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX blob_uploads_open_idx ON blob_uploads (expires_at) WHERE state IN ('granted', 'verifying', 'verified');
CREATE INDEX blob_uploads_key_idx ON blob_uploads (key);

-- Time-limited share links of a job output (owner / admin; audited; revocable). The token itself is shown once.
CREATE TABLE blob_share_links (
  id           uuid PRIMARY KEY,
  token_hash   bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  project      text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  job_id       uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  artifact_id  text NOT NULL CHECK (artifact_id ~ '^ws-[a-z0-9-]{1,100}$'),
  attempt_id   uuid NOT NULL,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  created_by   uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz NULL,
  revoked_by   uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  last_used_at timestamptz NULL,
  use_count    integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  CHECK (expires_at > created_at)
);
CREATE INDEX blob_share_links_job_idx ON blob_share_links (job_id, artifact_id, created_at DESC);
