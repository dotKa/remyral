-- p15-coolify-dedupe (ADR-0057 amendment, docs/design/p15-coolify-dedupe.md): the assistant created five Coolify
-- applications for one app (every failed deploy became a new application). Remana now refuses duplicates, lets the
-- assistant read deployment / application logs and change an application's build settings, and can delete an
-- application of a project.
--  * coolify_app_creations.deleted_at / deleted_by: the application was deleted through Remana (panel or assistant).
--    A deleted creation is history only: it no longer makes its application "an application of this project".
--
-- Rollback: the old master ignores both columns; drop them by hand only after a rollback is final
--   ALTER TABLE coolify_app_creations DROP COLUMN deleted_at, DROP COLUMN deleted_by;

ALTER TABLE coolify_app_creations
  ADD COLUMN deleted_at timestamptz NULL,
  ADD COLUMN deleted_by uuid NULL REFERENCES users (id) ON DELETE SET NULL;

CREATE INDEX coolify_app_creations_app ON coolify_app_creations (project, app_uuid) WHERE app_uuid IS NOT NULL;
