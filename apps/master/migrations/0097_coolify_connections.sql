-- p13-multi-coolify (ADR-0050, docs/design/p13-multi-coolify.md): several Coolify connections. The single Coolify
-- integration becomes the connection "Sunucu Coolify (varsayılan)" — the encrypted token moves as it is (no re-entry);
-- deploy targets, Coolify ops actions, pending deploys on success and Coolify uptime monitors are stamped with its id.

CREATE TABLE coolify_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label            text NOT NULL UNIQUE CHECK (length(label) BETWEEN 1 AND 80),
  -- Non-secret settings: {url, team, denyResources[], openUrl, useServerSso} (validated by zod: CoolifyConnectionSettings).
  config           jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  -- AES-256-GCM under the HKDF sub-key `ops-integrations` of the master key file; AAD in `secret_aad`
  -- (`coolify-connection:<id>`, or `ops-integration:coolify` for the migrated token until it is replaced).
  secret           bytea NOT NULL,
  secret_aad       text NOT NULL CHECK (secret_aad ~ '^(ops-integration:coolify|coolify-connection:[0-9a-f-]{36})$'),
  key_fingerprint  text NOT NULL CHECK (key_fingerprint ~ '^[0-9a-f]{16}$'),
  is_default       boolean NOT NULL DEFAULT false,
  -- Every project may use it (else only those in coolify_connection_projects).
  all_projects     boolean NOT NULL DEFAULT false,
  last_test        jsonb NULL CHECK (last_test IS NULL OR jsonb_typeof(last_test) = 'object'),
  last_test_at     timestamptz NULL,
  updated_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);
CREATE UNIQUE INDEX coolify_connections_one_default ON coolify_connections (is_default) WHERE is_default;

CREATE TABLE coolify_connection_projects (
  connection_id  uuid NOT NULL REFERENCES coolify_connections (id) ON DELETE CASCADE,
  project        text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  PRIMARY KEY (connection_id, project)
);
CREATE INDEX coolify_connection_projects_project_idx ON coolify_connection_projects (project);

INSERT INTO coolify_connections (label, config, secret, secret_aad, key_fingerprint, is_default, all_projects,
                                 last_test, last_test_at, updated_by, created_at, updated_at)
SELECT 'Sunucu Coolify (varsayılan)',
       config || jsonb_build_object('useServerSso', true),
       secret, 'ops-integration:coolify', key_fingerprint, true, true, last_test, last_test_at, updated_by,
       created_at, updated_at
  FROM ops_integrations WHERE provider = 'coolify';

-- Deploy targets: each configured Coolify environment names the connection.
UPDATE project_deploy_targets t
   SET config = jsonb_set(t.config, '{coolify,preview,connection}', to_jsonb(c.id::text))
  FROM coolify_connections c
 WHERE c.is_default AND jsonb_typeof(t.config -> 'coolify' -> 'preview') = 'object';
UPDATE project_deploy_targets t
   SET config = jsonb_set(t.config, '{coolify,production,connection}', to_jsonb(c.id::text))
  FROM coolify_connections c
 WHERE c.is_default AND jsonb_typeof(t.config -> 'coolify' -> 'production') = 'object';

-- Coolify ops actions: the connection they ran on (status polling, logs and rollback continue on it).
UPDATE ops_actions a
   SET target = a.target || jsonb_build_object('connection', jsonb_build_object('id', c.id::text, 'label', c.label))
  FROM coolify_connections c
 WHERE c.is_default AND a.kind LIKE 'coolify.%';
UPDATE ops_actions a
   SET params = a.params || jsonb_build_object('connection', c.id::text)
  FROM coolify_connections c
 WHERE c.is_default AND a.kind = 'coolify.rollback';

-- Pending deploys on success compare their target snapshot: it now includes the connection.
UPDATE job_deploy_on_success d
   SET target_snapshot = jsonb_set(d.target_snapshot, '{coolify,connection}', to_jsonb(c.id::text))
  FROM coolify_connections c
 WHERE c.is_default AND d.target = 'coolify' AND jsonb_typeof(d.target_snapshot -> 'coolify') = 'object';

-- Coolify uptime monitors check through a connection.
UPDATE uptime_monitors m
   SET config = m.config || jsonb_build_object('connection', c.id::text)
  FROM coolify_connections c
 WHERE c.is_default AND m.type = 'coolify';

DELETE FROM ops_integrations WHERE provider = 'coolify';
