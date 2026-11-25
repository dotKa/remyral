-- p10-site-upload (docs/design/p10-site-upload.md, ADR-0037): a person uploads a ready-made static site (folder or
-- .zip, unpacked in the browser) through Project → Deploy; the master checks every file and keeps it until a
-- `pages.deploy` ops action with `uploadId` publishes it to Cloudflare Pages. The console never serves these bytes
-- back (HTML would run on the console origin); only the master's Pages upload reads them. Migration number 0083
-- (0082 = p10-chat-memory-suggestions; renumber at merge if a parallel change took it). Additive only.

CREATE TABLE site_uploads (
  id               uuid PRIMARY KEY,
  project          text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  uploaded_by      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- receiving: parts arrive (chunked, resumable); ready: checked, stored per file, deployable.
  state            text NOT NULL CHECK (state IN ('receiving', 'ready')),
  -- What the person picked (folder or zip name), shown only as text.
  label            text NULL CHECK (label IS NULL OR length(label) <= 200),
  -- The declared files in upload order: [{path, size, sha256, contentType}] (validated by the master at start).
  manifest         jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'array'),
  file_count       integer NOT NULL CHECK (file_count BETWEEN 1 AND 500),
  total_bytes      bigint NOT NULL CHECK (total_bytes BETWEEN 1 AND 52428800),
  part_size        integer NOT NULL CHECK (part_size BETWEEN 65536 AND 4194304),
  part_count       integer NOT NULL CHECK (part_count >= 1),
  -- SHA-256 over the manifest (paths + hashes): what a deploy's diff and plan key name.
  site_sha256      text NOT NULL CHECK (site_sha256 ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz NOT NULL,
  -- receiving: sliding expiry (every part extends it); ready: NULL (retention by the sweep).
  expires_at       timestamptz NULL,
  completed_at     timestamptz NULL,
  last_deployed_at timestamptz NULL,
  last_action_id   uuid NULL REFERENCES ops_actions (id) ON DELETE SET NULL
);
CREATE INDEX site_uploads_project ON site_uploads (project, created_at DESC);
CREATE INDEX site_uploads_user ON site_uploads (uploaded_by) WHERE state = 'receiving';

-- Raw parts while receiving (deleted when the upload completes or is discarded).
CREATE TABLE site_upload_parts (
  upload_id uuid NOT NULL REFERENCES site_uploads (id) ON DELETE CASCADE,
  n         integer NOT NULL CHECK (n >= 0),
  sha256    text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes     bytea NOT NULL,
  PRIMARY KEY (upload_id, n)
);

-- The checked files of a ready upload (one row per file; ≤ 25 MiB each, Cloudflare Pages' asset limit).
CREATE TABLE site_upload_files (
  upload_id    uuid NOT NULL REFERENCES site_uploads (id) ON DELETE CASCADE,
  idx          integer NOT NULL CHECK (idx >= 0),
  path         text NOT NULL CHECK (length(path) BETWEEN 1 AND 300),
  content_type text NOT NULL,
  size_bytes   integer NOT NULL CHECK (size_bytes BETWEEN 0 AND 26214400),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content      bytea NOT NULL,
  PRIMARY KEY (upload_id, idx),
  UNIQUE (upload_id, path)
);
