-- p17-remyral-rebrand (docs/design/p17-remyral-rebrand.md, docs/ops/remyral-cutover.md): the product is Remyral.
-- Applied migrations are checksummed and never edited, so the data-side changes of the rename live here.

-- 1. Support address: the new default is info@remyral.com. A stored value is changed ONLY while it is still the old
--    default; an address the owner chose is kept.
UPDATE support_settings SET email = 'info@remyral.com' WHERE id = 1 AND email = 'yasin@remana.tech';

-- 2. Worker releases: which domain the release signature verified under (p17 signing-domain transition). Every
--    release stored before this migration was signed under the pre-rename domain `remana-worker-release/v1`.
--    The master offers a `current`-signed release only to workers that run the transition release or newer.
ALTER TABLE worker_releases
  ADD COLUMN signing_domain text NOT NULL DEFAULT 'legacy' CHECK (signing_domain IN ('legacy', 'current'));
ALTER TABLE worker_releases ALTER COLUMN signing_domain SET DEFAULT 'current';

-- 3. Installer kits are named remyral-worker-<version>-<os>.<ext> now; kits stored before keep their names (they
--    are bound to their signed index).
ALTER TABLE worker_release_installer_kits DROP CONSTRAINT worker_release_installer_kits_file_name_check;
ALTER TABLE worker_release_installer_kits ADD CONSTRAINT worker_release_installer_kits_file_name_check
  CHECK (file_name ~ '^(remyral|remana)-worker-[0-9A-Za-z.-]{5,64}-(linux\.tar\.gz|macos\.tar\.gz|windows\.zip)$');

-- 4. MCP catalog: `remyral*` ids are reserved like `remana*` were (the worker's own servers use the prefix).
ALTER TABLE mcp_servers DROP CONSTRAINT mcp_servers_id_check;
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_id_check
  CHECK (id ~ '^[a-z][a-z0-9-]{1,31}$' AND id !~ '^(remyral|remana|subtask)' AND id NOT IN ('admin', 'preview', 'deploy'));
