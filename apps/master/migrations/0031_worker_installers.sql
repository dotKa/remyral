-- p5-worker-onboarding (docs/design/p5-worker-onboarding.md): signed installer kits for Fleet → "Add machine".
-- Rows are written only through src/installers/*.
--
-- Per release version, the installer index signed offline with the release key (domain
-- `remana-worker-installers/v1`) and one kit per OS. The master verifies the index against
-- RELEASE_PUBLIC_KEYS and every kit against its SHA-256 and size before inserting anything; it cannot
-- sign. A kit set is bound to the exact manifest bytes of the release (release_manifest_sha256): when a
-- release is re-signed (canary → stable) the kits stop being served until new ones are uploaded.

CREATE TABLE worker_release_installers (
  version                  text PRIMARY KEY REFERENCES worker_releases (version) ON DELETE CASCADE,
  index_doc                bytea NOT NULL CHECK (length(index_doc) BETWEEN 1 AND 16384),
  -- {keyId, signature} (protocol ReleaseSignature) over `remana-worker-installers/v1\n` ‖ index_doc.
  signature                jsonb NOT NULL CHECK (jsonb_typeof(signature) = 'object'),
  key_id                   text NOT NULL CHECK (key_id ~ '^[a-f0-9]{16}$'),
  release_manifest_sha256  text NOT NULL CHECK (release_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  node_version             text NOT NULL CHECK (node_version ~ '^24\.[0-9]{1,4}\.[0-9]{1,4}$'),
  uploaded_at              timestamptz NOT NULL,
  uploaded_by              uuid NULL REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE worker_release_installer_kits (
  version     text NOT NULL REFERENCES worker_release_installers (version) ON DELETE CASCADE,
  os          text NOT NULL CHECK (os IN ('linux', 'macos', 'windows')),
  file_name   text NOT NULL CHECK (file_name ~ '^remana-worker-[0-9A-Za-z.-]{5,64}-(linux\.tar\.gz|macos\.tar\.gz|windows\.zip)$'),
  sha256      text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes  integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 25165824),
  content     bytea NOT NULL,
  CHECK (length(content) = size_bytes),
  PRIMARY KEY (version, os)
);
