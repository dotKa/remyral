-- p8-preview-tunnels (ADR-0032, docs/design/p8-preview-tunnels.md): preview links through Cloudflare Tunnel. The
-- master creates a remotely-managed named tunnel per preview with its account token (ADR-0028), routes one
-- hostname of the project's preview zone to `http://localhost:<port>` on the job's worker, optionally behind a
-- Cloudflare Access application, and sends the worker only that tunnel's connector token (never stored here).
-- Additive: new table, new ops action kinds and requester channel, one workers column.
-- Migration number 0067: renumber at merge if a parallel change took it.

-- One preview tunnel. Job-bound tunnels are closed when their job attempt ends or their lifetime is over; stable
-- tunnels keep their hostname (an APK's backend address) across jobs until closed or expired.
CREATE TABLE preview_tunnels (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project            text NOT NULL REFERENCES projects (id),
  -- Short name (job tools / console), unique among the project's open stable tunnels.
  name               text NOT NULL CHECK (name ~ '^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$'),
  stable             boolean NOT NULL DEFAULT false,
  hostname           text NOT NULL CHECK (hostname ~ '^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$' AND length(hostname) <= 253),
  zone_id            text NOT NULL CHECK (zone_id ~ '^[0-9a-f]{32}$'),
  zone_name          text NOT NULL,
  protection         text NOT NULL CHECK (protection IN ('none', 'access', 'service-token')),
  -- Cloudflare resources (ids only; the connector token is fetched from Cloudflare whenever it is sent).
  cf_tunnel_id       uuid NULL,
  dns_record_id      text NULL CHECK (dns_record_id IS NULL OR dns_record_id ~ '^[A-Za-z0-9]{1,64}$'),
  access_app_id      uuid NULL,
  service_token_id   uuid NULL,
  service_token_client_id text NULL CHECK (service_token_client_id IS NULL OR length(service_token_client_id) <= 256),
  -- AES-256-GCM under the HKDF sub-key `preview-tunnels` of the master key file, AAD `preview-service-token:<id>`.
  service_token_secret bytea NULL,
  state              text NOT NULL CHECK (state IN ('opening', 'active', 'idle', 'closing', 'closed', 'failed')),
  -- The job attempt the connector runs for (null: a stable tunnel no job serves right now, or closed).
  job_id             uuid NULL REFERENCES jobs (id),
  attempt_id         uuid NULL,
  epoch              integer NULL,
  worker_id          text NULL CHECK (worker_id IS NULL OR worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  port               integer NULL CHECK (port IS NULL OR port BETWEEN 1024 AND 65535),
  port_check         text NULL CHECK (port_check IS NULL OR port_check IN ('owned', 'declared')),
  -- Connector state reported by the worker (TUNNEL_STATUS) or `down` when its worker went away.
  connector_state    text NULL CHECK (connector_state IS NULL OR connector_state IN
                                        ('starting', 'running', 'stopped', 'failed', 'refused', 'down')),
  connector_detail   text NULL CHECK (connector_detail IS NULL OR length(connector_detail) <= 300),
  connector_at       timestamptz NULL,
  -- When TUNNEL_START was last sent (re-sent on reconnect / extend).
  started_at         timestamptz NULL,
  opened_by_type     text NOT NULL CHECK (opened_by_type IN ('user', 'system')),
  opened_by_id       text NOT NULL CHECK (length(opened_by_id) BETWEEN 1 AND 128),
  open_action_id     uuid NULL REFERENCES ops_actions (id),
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  closed_at          timestamptz NULL,
  close_reason       text NULL CHECK (close_reason IS NULL OR length(close_reason) <= 300),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
  CHECK ((service_token_id IS NULL) = (service_token_secret IS NULL) OR state = 'closed')
);
CREATE UNIQUE INDEX preview_tunnels_hostname_open ON preview_tunnels (hostname) WHERE state <> 'closed';
CREATE UNIQUE INDEX preview_tunnels_stable_name ON preview_tunnels (project, name) WHERE stable AND state <> 'closed';
CREATE INDEX preview_tunnels_project_idx ON preview_tunnels (project, created_at DESC);
CREATE INDEX preview_tunnels_job_idx ON preview_tunnels (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX preview_tunnels_open_idx ON preview_tunnels (state, expires_at) WHERE state <> 'closed';

-- Ops action kinds: + tunnel.open, tunnel.close, tunnel.extend; requester channel: + job (a job's agent tool or
-- its auto-open, recorded as system `job:<id>` with the job's creator re-authorized).
ALTER TABLE ops_actions DROP CONSTRAINT ops_actions_kind_check;
ALTER TABLE ops_actions ADD CONSTRAINT ops_actions_kind_check
  CHECK (kind IN ('coolify.deploy', 'coolify.restart', 'coolify.rollback', 'pages.deploy', 'pages.rollback',
                  'dns.upsert', 'dns.delete', 'pages.create_project', 'pages.add_domain',
                  'tunnel.open', 'tunnel.close', 'tunnel.extend'));
ALTER TABLE ops_actions DROP CONSTRAINT ops_actions_via_check;
ALTER TABLE ops_actions ADD CONSTRAINT ops_actions_via_check
  CHECK (via IN ('api', 'chat', 'automation', 'workflow', 'job'));

-- The worker's last CAPABILITIES.previewTunnels (cloudflared availability, running connectors).
ALTER TABLE workers
  ADD COLUMN preview_tunnels jsonb NULL CHECK (preview_tunnels IS NULL OR jsonb_typeof(preview_tunnels) = 'object'),
  ADD COLUMN preview_tunnels_at timestamptz NULL;

-- Mobile app packages (.apk / .aab / .ipa) are workspace outputs with their own size limit (80 MiB, MAX_PACKAGE_BYTES);
-- every other output keeps the 5 MiB limit.
ALTER TABLE job_artifacts DROP CONSTRAINT job_artifacts_size_bytes_check;
ALTER TABLE job_artifacts ADD CONSTRAINT job_artifacts_size_bytes_check
  CHECK (size_bytes BETWEEN 0 AND 5242880
         OR (media_type IN ('application/vnd.android.package-archive', 'application/x-android-app-bundle',
                            'application/x-ios-app')
             AND size_bytes BETWEEN 0 AND 83886080));
