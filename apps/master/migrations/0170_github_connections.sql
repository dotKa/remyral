-- p17-chat-github Part 3 (docs/design/p17-chat-github.md §3, ADR-0022 amendment 2026-10-27): several GitHub App
-- connections, each its own (private) App — a private App can only be installed on the account that owns it, so one
-- App per organization / account.
--
--  * github_app_connection: no longer "at most one" (the id = 1 check goes; new rows take ids from a sequence). Each
--    connection has its own key reference (`panel` for the first — existing projects keep pointing at it — then
--    `panel-<id>`), an optional label (rename in the panel) and a unique App id.
--  * github_app_installations: an allowlist — only installations accepted in the panel are used (repository listing,
--    project configuration, installation tokens of panel Apps). Installations that exist today are accepted (they
--    were in use); new ones are pending until an admin accepts them.
--  * github_manifest_states: the label the new connection gets (optional).
--
-- Additive except the dropped id check. Rollback: an older master reads `WHERE id = 1` only (the first connection,
-- as before) and ignores the rest; to undo: DELETE FROM github_app_connection WHERE id <> 1; then
--   ALTER TABLE github_app_connection ADD CONSTRAINT github_app_connection_id_check CHECK (id = 1);

ALTER TABLE github_app_connection DROP CONSTRAINT github_app_connection_id_check;
CREATE SEQUENCE github_app_connection_id_seq AS smallint START WITH 2 MAXVALUE 32000 OWNED BY github_app_connection.id;
ALTER TABLE github_app_connection ALTER COLUMN id SET DEFAULT nextval('github_app_connection_id_seq');
ALTER TABLE github_app_connection ADD CONSTRAINT github_app_connection_id_positive CHECK (id > 0);

ALTER TABLE github_app_connection
  ADD COLUMN key_ref text NULL,
  ADD COLUMN label text NULL CHECK (label IS NULL OR (char_length(label) BETWEEN 1 AND 60 AND label !~ '[[:cntrl:]]'));
UPDATE github_app_connection SET key_ref = CASE WHEN id = 1 THEN 'panel' ELSE 'panel-' || id::text END;
ALTER TABLE github_app_connection ALTER COLUMN key_ref SET NOT NULL, ALTER COLUMN key_ref SET DEFAULT 'panel';
ALTER TABLE github_app_connection
  ADD CONSTRAINT github_app_connection_key_ref_check CHECK (key_ref ~ '^panel(-[0-9]{1,5})?$');
CREATE UNIQUE INDEX github_app_connection_key_ref ON github_app_connection (key_ref);
CREATE UNIQUE INDEX github_app_connection_app ON github_app_connection (app_id);

ALTER TABLE github_app_installations
  ADD COLUMN accepted_at timestamptz NULL,
  ADD COLUMN accepted_by uuid NULL REFERENCES users (id) ON DELETE SET NULL;
UPDATE github_app_installations SET accepted_at = now();

ALTER TABLE github_manifest_states
  ADD COLUMN label text NULL CHECK (label IS NULL OR (char_length(label) BETWEEN 1 AND 60 AND label !~ '[[:cntrl:]]'));
