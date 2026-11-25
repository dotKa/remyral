-- p19-ide W3 (docs/design/p19-ide.md §4, owner decision 4): IDE extensions from Open VSX through an admin allowlist,
-- project required / recommended lists, the user's own list, and per-user settings sync.
--
--  ide_extension_policy  one global row (project NULL: registry URL, "verified publishers only", deny list) and one row
--                        per project (required, recommended, deny, enforced settings). Admins write it (audited).
--  ide_extensions        the admin allowlist: one approved version per extension (`publisher.name`), with the Open VSX
--                        facts read at approval (display name, verified publisher, dependencies, engine).
--  ide_extension_blobs   the master cache: the verified VSIX per (extension, version, target platform) in the blob
--                        store (kind `ide-extension`), its SHA-256, size, and how the signature was checked.
--  ide_user_settings     the user's extension list and synced settings.json / keybindings.json (≤ 256 KiB each, a
--                        secret-looking value is refused before it is stored).
--  ide_workspaces.extensions  what the last start installed / could not install (IDE_STATUS).
--
-- Additive. Rollback: an older master ignores the tables and the column (workers then get no profile and install only
-- the bridge extension); to remove: DROP TABLE ide_user_settings, ide_extension_blobs, ide_extensions,
-- ide_extension_policy; ALTER TABLE ide_workspaces DROP COLUMN extensions; and restore the two blob_objects checks of
-- 0157 after deleting the `ide-extension` blob rows.

ALTER TABLE blob_objects DROP CONSTRAINT blob_objects_key_check;
ALTER TABLE blob_objects ADD CONSTRAINT blob_objects_key_check CHECK (
  key ~ '^(artifacts|inputs|site-uploads|releases|kits|chat-attachments|workflow-files|automation-files|input-uploads|ide-extensions)/[A-Za-z0-9][A-Za-z0-9._-]{0,127}(/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,4}$');
ALTER TABLE blob_objects DROP CONSTRAINT blob_objects_kind_check;
ALTER TABLE blob_objects ADD CONSTRAINT blob_objects_kind_check CHECK (
  kind IN ('artifact', 'input', 'site-upload', 'release', 'kit', 'chat-attachment', 'workflow-file',
           'automation-file', 'input-bundle', 'ide-extension'));

CREATE TABLE ide_extension_policy (
  id                 bigserial PRIMARY KEY,
  -- NULL: the global row; otherwise the project's.
  project            text NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- Global: an Open VSX-compatible registry (https). NULL: https://open-vsx.org.
  registry_url       text NULL CHECK (registry_url IS NULL OR (registry_url ~ '^https://' AND length(registry_url) <= 300)),
  -- Global: only extensions whose Open VSX publisher is verified may be allowed / installed.
  verified_only      boolean NOT NULL DEFAULT false,
  deny               jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(deny) = 'array' AND jsonb_array_length(deny) <= 500),
  -- Project: installed at every workspace start (the user cannot remove them) / offered to the user.
  required           jsonb NOT NULL DEFAULT '[]'
                     CHECK (jsonb_typeof(required) = 'array' AND jsonb_array_length(required) <= 100),
  recommended        jsonb NOT NULL DEFAULT '[]'
                     CHECK (jsonb_typeof(recommended) = 'array' AND jsonb_array_length(recommended) <= 100),
  -- Project: settings written as machine settings at every start (presentation, not a boundary).
  enforced_settings  jsonb NOT NULL DEFAULT '{}'
                     CHECK (jsonb_typeof(enforced_settings) = 'object' AND octet_length(enforced_settings::text) <= 65536),
  updated_by         uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL,
  CHECK (project IS NOT NULL OR (required = '[]' AND recommended = '[]' AND enforced_settings = '{}'))
);
CREATE UNIQUE INDEX ide_extension_policy_scope ON ide_extension_policy ((coalesce(project, '')));

CREATE TABLE ide_extensions (
  id                 text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9._-]{0,63}$'),
  version            text NOT NULL CHECK (version ~ '^[0-9][0-9A-Za-z.+-]{0,63}$'),
  -- true: the admin chose this exact version; false: "latest at approval time" (still this fixed version).
  pinned             boolean NOT NULL,
  display_name       text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  description        text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  publisher_verified boolean NOT NULL,
  license            text NULL CHECK (license IS NULL OR length(license) <= 200),
  engine             text NULL CHECK (engine IS NULL OR length(engine) <= 64),
  dependencies       jsonb NOT NULL DEFAULT '[]'
                     CHECK (jsonb_typeof(dependencies) = 'array' AND jsonb_array_length(dependencies) <= 64),
  registry_url       text NOT NULL CHECK (registry_url ~ '^https://' AND length(registry_url) <= 300),
  approved_by        uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  approved_at        timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL
);

CREATE TABLE ide_extension_blobs (
  extension_id       text NOT NULL REFERENCES ide_extensions (id) ON DELETE CASCADE,
  version            text NOT NULL,
  target_platform    text NOT NULL CHECK (target_platform IN ('universal', 'linux-x64', 'linux-arm64', 'linux-armhf')),
  blob_key           text NOT NULL,
  sha256             text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes         bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 104857600),
  -- `ed25519`: the registry's signature over the VSIX verified with its published key.
  signature          text NOT NULL CHECK (signature IN ('ed25519')),
  -- The signing key: the registry's key id and the SHA-256 of its raw public key; `pinned` = a key this master
  -- release ships for open-vsx.org.
  key_id             text NOT NULL CHECK (length(key_id) BETWEEN 1 AND 100),
  key_fingerprint    text NOT NULL CHECK (key_fingerprint ~ '^[0-9a-f]{64}$'),
  key_pinned         boolean NOT NULL,
  fetched_at         timestamptz NOT NULL,
  PRIMARY KEY (extension_id, version, target_platform)
);
CREATE INDEX ide_extension_blobs_sha_idx ON ide_extension_blobs (sha256);
CREATE INDEX ide_extension_blobs_key_idx ON ide_extension_blobs (blob_key);

CREATE TABLE ide_user_settings (
  user_id              uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  extensions           jsonb NOT NULL DEFAULT '[]'
                       CHECK (jsonb_typeof(extensions) = 'array' AND jsonb_array_length(extensions) <= 100),
  -- The synced files as the IDE wrote them (JSON with comments); NULL: never saved.
  settings             text NULL CHECK (settings IS NULL OR octet_length(settings) <= 262144),
  keybindings          text NULL CHECK (keybindings IS NULL OR octet_length(keybindings) <= 262144),
  settings_updated_at  timestamptz NULL,
  updated_at           timestamptz NOT NULL
);

ALTER TABLE ide_workspaces ADD COLUMN extensions jsonb NULL
  CHECK (extensions IS NULL OR (jsonb_typeof(extensions) = 'object' AND octet_length(extensions::text) <= 131072));
