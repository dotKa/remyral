-- p16-zip-job-input (docs/design/p16-zip-job-input.md, ADR-0060): a .zip the owner drops into the chat (or the job
-- composer) becomes a job input bundle — unpacked in the browser (the master never parses archives), uploaded in
-- chunks like a site upload (p10-site-upload), checked file by file (SHA-256, path rules, native executables by magic
-- bytes unless the security policy allows them, secret scan of text files: a finding blocks unless the uploader sends it
-- anyway, audited) and stored here. A job that names it (`draft_job inputUpload`, `POST /jobs inputUpload`) is pulled
-- into its `in/` by the worker through the master (INPUT_BUNDLE_REQUEST, lease-checked) before the agent runs.
--
-- Retention: receiving uploads 1 h sliding; ready bundles 14 days after their last use (or completion), never while an
-- unfinished job still needs one, and at most the 20 newest per project. Additive only.
--
-- Rollback: an older master never reads these tables; drop them when wanted:
--   DROP TABLE job_input_uploads, input_upload_files, input_upload_parts, input_uploads;
-- Migration number 0145 (0144 = p16-webhooks-out, taken in parallel).

CREATE TABLE input_uploads (
  id                   uuid PRIMARY KEY,
  project              text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  uploaded_by          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- receiving: parts arrive (chunked, resumable); ready: checked, stored per file, usable by jobs.
  state                text NOT NULL CHECK (state IN ('receiving', 'ready')),
  -- The .zip's display name, shown only as text.
  label                text NULL CHECK (label IS NULL OR length(label) <= 200),
  -- The declared files in upload order: [{path, size, sha256}] (validated by the master at start).
  manifest             jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'array'),
  file_count           integer NOT NULL CHECK (file_count BETWEEN 1 AND 2000),
  total_bytes          bigint NOT NULL CHECK (total_bytes BETWEEN 1 AND 104857600),
  part_size            integer NOT NULL CHECK (part_size BETWEEN 65536 AND 4194304),
  part_count           integer NOT NULL CHECK (part_count >= 1),
  -- SHA-256 over the JSON array of [path, sha256] in upload order (what the worker checks the listing against).
  bundle_sha256        text NOT NULL CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  created_at           timestamptz NOT NULL,
  -- receiving: sliding expiry (every part extends it); ready: NULL (retention by the sweep).
  expires_at           timestamptz NULL,
  completed_at         timestamptz NULL,
  -- The newest job that took it (creation or a pull): the 14-day retention counts from here.
  last_used_at         timestamptz NULL,
  -- Secret findings the uploader sent anyway: [{path, rule, line}] (never a value); empty: none were found.
  secret_findings      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(secret_findings) = 'array'),
  secrets_override_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  secrets_override_at  timestamptz NULL,
  -- The chat message that carried it (cleared when the conversation / message is deleted).
  chat_thread_id       uuid NULL REFERENCES chat_threads (id) ON DELETE SET NULL,
  chat_message_id      uuid NULL REFERENCES chat_messages (id) ON DELETE SET NULL
);
CREATE INDEX input_uploads_project ON input_uploads (project, created_at DESC);
CREATE INDEX input_uploads_user ON input_uploads (uploaded_by) WHERE state = 'receiving';
CREATE INDEX input_uploads_chat_thread ON input_uploads (chat_thread_id) WHERE chat_thread_id IS NOT NULL;

-- Raw parts while receiving (deleted when the upload completes or is discarded).
CREATE TABLE input_upload_parts (
  upload_id uuid NOT NULL REFERENCES input_uploads (id) ON DELETE CASCADE,
  n         integer NOT NULL CHECK (n >= 0),
  sha256    text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes     bytea NOT NULL,
  PRIMARY KEY (upload_id, n)
);

-- The checked files of a ready bundle (one row per file, ≤ 25 MiB each). EXTERNAL storage (out of line, not
-- compressed) so the worker relay's substring() reads only the slice it needs.
CREATE TABLE input_upload_files (
  upload_id  uuid NOT NULL REFERENCES input_uploads (id) ON DELETE CASCADE,
  idx        integer NOT NULL CHECK (idx >= 0),
  path       text NOT NULL CHECK (length(path) BETWEEN 1 AND 300),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 0 AND 26214400),
  sha256     text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content    bytea NOT NULL,
  PRIMARY KEY (upload_id, idx),
  UNIQUE (upload_id, path)
);
ALTER TABLE input_upload_files ALTER COLUMN content SET STORAGE EXTERNAL;

-- The bundle a job starts with (one per job). The facts stay readable after the bundle itself was pruned
-- (upload_id is then NULL: the job page says "no longer kept").
CREATE TABLE job_input_uploads (
  job_id        uuid PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  upload_id     uuid NULL REFERENCES input_uploads (id) ON DELETE SET NULL,
  -- The id as attached (kept when upload_id is cleared, for the job page and the audit trail).
  source_id     uuid NOT NULL,
  label         text NULL,
  file_count    integer NOT NULL,
  total_bytes   bigint NOT NULL,
  bundle_sha256 text NOT NULL,
  attached_at   timestamptz NOT NULL,
  -- The first successful pull of the bundle by a worker (null: not pulled yet).
  pulled_at     timestamptz NULL
);
CREATE INDEX job_input_uploads_upload ON job_input_uploads (upload_id) WHERE upload_id IS NOT NULL;
