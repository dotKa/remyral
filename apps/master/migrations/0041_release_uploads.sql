-- p6-release-upload (docs/ops/worker-updates.md §2): resumable chunked upload of a signed `release.json`.
-- Rows are written only through src/releases/uploads.ts. Temporary: a row lives from
-- `POST /releases/uploads` until `complete` (then it goes through exactly the `POST /releases`
-- verification path and is deleted, accepted or refused), `DELETE`, or expiry (swept).
--
-- Nothing here is trusted: the assembled document is verified against its declared SHA-256 and then
-- against the release signature like any direct upload.
-- Migration number 0041: renumber at merge if a parallel change took it.

CREATE TABLE worker_release_uploads (
  id           uuid PRIMARY KEY,
  -- The admin who started it; only they can add parts, complete or abort it.
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Whole document: size and SHA-256 (lowercase hex) declared at start, verified at complete.
  total_bytes  integer NOT NULL CHECK (total_bytes BETWEEN 1 AND 50331648),
  sha256       text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  -- Every part except the last is exactly part_size bytes (≤ 4 MiB).
  part_size    integer NOT NULL CHECK (part_size BETWEEN 65536 AND 4194304),
  part_count   integer NOT NULL CHECK (part_count BETWEEN 1 AND 768),
  created_at   timestamptz NOT NULL,
  -- Sliding: every accepted part extends it.
  expires_at   timestamptz NOT NULL
);

CREATE INDEX worker_release_uploads_user ON worker_release_uploads (user_id);
CREATE INDEX worker_release_uploads_expiry ON worker_release_uploads (expires_at);

CREATE TABLE worker_release_upload_parts (
  upload_id  uuid NOT NULL REFERENCES worker_release_uploads (id) ON DELETE CASCADE,
  n          integer NOT NULL CHECK (n >= 0),
  sha256     text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  bytes      bytea NOT NULL CHECK (length(bytes) BETWEEN 1 AND 4194304),
  PRIMARY KEY (upload_id, n)
);
