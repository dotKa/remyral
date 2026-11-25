-- p17-coolify-full (docs/design/p17-coolify-full.md §5): paths of a Coolify resource that must be persistent.
--
--  * coolify_data_paths: a container path (`/data`) that Remyral put on a persistent storage (a volume or a host
--    directory added through the panel or the assistant) for one resource of one Coolify connection. The storage
--    view warns ("not persistent: lost at every deploy") when such a path — or a data path a variable names — has no
--    storage. Paths only; never a value, never file content.
--
-- Additive. Rollback: an older master ignores the table; to remove:
--   DROP TABLE coolify_data_paths;

CREATE TABLE coolify_data_paths (
  connection_id uuid NOT NULL REFERENCES coolify_connections (id) ON DELETE CASCADE,
  resource_uuid text NOT NULL CHECK (resource_uuid ~ '^[A-Za-z0-9]{6,64}$'),
  path text NOT NULL CHECK (path ~ '^/[A-Za-z0-9._@+/-]*$' AND length(path) <= 500),
  created_by uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, resource_uuid, path)
);
