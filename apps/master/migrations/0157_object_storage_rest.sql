-- p17-object-storage-rest (docs/design/p17-object-storage.md §13): the remaining bounded blobs move out of Postgres
-- into the blob store (the configured bucket, else the master's local blob directory) like job outputs did in 0154:
-- chat attachments, workflow run files, automation files and the checked files of job input bundles
-- (p16-zip-job-input). New writes go to the store; rows written before keep their bytea until
-- `remyral-master blobs:migrate` moves them (reads accept both).
--
--  * blob_objects: four more key prefixes / kinds; `prior_location` + `prior_store_ref` name the copy in the previous
--    store while `blobs:migrate --to-store` moves a blob between stores (local disk ↔ bucket) — set in the same
--    statement that points the row at the verified new copy, cleared once the old copy is deleted (a run cut short
--    finishes the deletion on the next run; the blob GC deletes it too when the blob itself goes).
--  * blob_key on chat_attachments, workflow_run_files, automation_files, input_upload_files (FK ON DELETE RESTRICT;
--    deleting the owning row — thread delete, run purge, automation delete, bundle retention — leaves the blob
--    unreferenced and the blob GC deletes it from its store). The bytea columns become nullable; a row's bytes are
--    the bytea or the blob, never both (a pruned workflow run file has neither).
--
-- Additive (new nullable columns, NOT NULL dropped, CHECKs widened to "bytea or blob"). Rollback: run
-- `remyral-master blobs:migrate --to-db` before deploying an older master (it cannot read rows whose bytes moved).

ALTER TABLE blob_objects DROP CONSTRAINT blob_objects_key_check;
ALTER TABLE blob_objects ADD CONSTRAINT blob_objects_key_check CHECK (
  key ~ '^(artifacts|inputs|site-uploads|releases|kits|chat-attachments|workflow-files|automation-files|input-uploads)/[A-Za-z0-9][A-Za-z0-9._-]{0,127}(/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,4}$');
ALTER TABLE blob_objects DROP CONSTRAINT blob_objects_kind_check;
ALTER TABLE blob_objects ADD CONSTRAINT blob_objects_kind_check CHECK (
  kind IN ('artifact', 'input', 'site-upload', 'release', 'kit', 'chat-attachment', 'workflow-file',
           'automation-file', 'input-bundle'));
ALTER TABLE blob_objects ADD COLUMN prior_location text NULL CHECK (prior_location IN ('local', 's3'));
ALTER TABLE blob_objects ADD COLUMN prior_store_ref text NULL
  CHECK (prior_store_ref IS NULL OR length(prior_store_ref) <= 600);
CREATE INDEX blob_objects_prior_idx ON blob_objects (key) WHERE prior_location IS NOT NULL;

-- Chat attachments (≤ 3.75 MiB each).
ALTER TABLE chat_attachments ALTER COLUMN content DROP NOT NULL;
ALTER TABLE chat_attachments ADD COLUMN blob_key text NULL REFERENCES blob_objects (key) ON DELETE RESTRICT;
ALTER TABLE chat_attachments ADD CONSTRAINT chat_attachments_store_check
  CHECK ((content IS NULL) <> (blob_key IS NULL));
CREATE INDEX chat_attachments_blob_idx ON chat_attachments (blob_key) WHERE blob_key IS NOT NULL;

-- Workflow run files (≤ 5 MiB each; pruned by the workspace retention: neither bytea nor blob).
ALTER TABLE workflow_run_files ADD COLUMN blob_key text NULL REFERENCES blob_objects (key) ON DELETE RESTRICT;
ALTER TABLE workflow_run_files DROP CONSTRAINT workflow_run_files_check;
ALTER TABLE workflow_run_files ADD CONSTRAINT workflow_run_files_pruned_check
  CHECK ((content IS NULL AND blob_key IS NULL) = (pruned_at IS NOT NULL));
ALTER TABLE workflow_run_files ADD CONSTRAINT workflow_run_files_one_store_check
  CHECK (content IS NULL OR blob_key IS NULL);
CREATE INDEX workflow_run_files_blob_idx ON workflow_run_files (blob_key) WHERE blob_key IS NOT NULL;

-- Automation files (templates, ≤ 5 MiB each).
ALTER TABLE automation_files ALTER COLUMN content DROP NOT NULL;
ALTER TABLE automation_files ADD COLUMN blob_key text NULL REFERENCES blob_objects (key) ON DELETE RESTRICT;
ALTER TABLE automation_files ADD CONSTRAINT automation_files_store_check
  CHECK ((content IS NULL) <> (blob_key IS NULL));
CREATE INDEX automation_files_blob_idx ON automation_files (blob_key) WHERE blob_key IS NOT NULL;

-- The checked files of a job input bundle (≤ 25 MiB each).
ALTER TABLE input_upload_files ALTER COLUMN content DROP NOT NULL;
ALTER TABLE input_upload_files ADD COLUMN blob_key text NULL REFERENCES blob_objects (key) ON DELETE RESTRICT;
ALTER TABLE input_upload_files ADD CONSTRAINT input_upload_files_store_check
  CHECK ((content IS NULL) <> (blob_key IS NULL));
CREATE INDEX input_upload_files_blob_idx ON input_upload_files (blob_key) WHERE blob_key IS NOT NULL;
