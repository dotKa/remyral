-- p8-uptime (docs/design/p8-uptime.md): uptime monitors of deployed sites and services. The master itself probes
-- (region "master" only): HTTP(S) and TCP checks behind an SSRF guard, and provider status checks (Cloudflare Pages
-- latest deployment, Coolify application status) with the master-held tokens. Checks are kept 30 days, hourly
-- rollups 90 days; incidents (down → up) are kept with the monitor. Rows are written only through src/uptime.
-- Migration number 0066 (0063–0065 taken by p8-pwa, p8-chat-attachments-mentions, p8-orchestration): renumber at merge if a parallel change took it.

CREATE TABLE uptime_monitors (
  id                    uuid PRIMARY KEY,
  project               text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  type                  text NOT NULL CHECK (type IN ('http', 'tcp', 'pages', 'coolify')),
  -- Type-specific settings (validated by src/uptime/model.ts): http {url, method, expectStatus, keyword, maxLatencyMs,
  -- maxRedirects, tlsWarnDays}; tcp {host, port}; pages {project, env}; coolify {uuid}. Never a credential.
  config                jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  -- The Outputs site item this monitor belongs to (site:<target>:<env>), or NULL.
  output_key            text NULL CHECK (output_key IS NULL OR (output_key ~ '^site:[A-Za-z0-9_.:+-]+$'
                                                                AND length(output_key) <= 320)),
  interval_sec          integer NOT NULL CHECK (interval_sec BETWEEN 30 AND 86400),
  timeout_ms            integer NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 30000),
  -- Failed checks in a row that are tolerated before the monitor is down (0: the first failure).
  retries               integer NOT NULL CHECK (retries BETWEEN 0 AND 10),
  paused                boolean NOT NULL DEFAULT false,
  status                text NOT NULL CHECK (status IN ('pending', 'up', 'down')),
  consecutive_failures  integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  -- Flap suppression: the last state changes (newest last, at most 20) and whether the monitor is flapping.
  transitions           timestamptz[] NOT NULL DEFAULT '{}' CHECK (cardinality(transitions) <= 20),
  flapping              boolean NOT NULL DEFAULT false,
  -- The status people were last told about (notifications and chat watches compare against it).
  notified_status       text NULL CHECK (notified_status IS NULL OR notified_status IN ('up', 'down')),
  last_check_at         timestamptz NULL,
  last_ok               boolean NULL,
  last_latency_ms       integer NULL,
  last_status_code      integer NULL,
  last_error            text NULL CHECK (last_error IS NULL OR length(last_error) <= 300),
  -- Provider status text ("success", "running:healthy") and TLS certificate expiry of the last check.
  last_detail           text NULL CHECK (last_detail IS NULL OR length(last_detail) <= 200),
  tls_expires_at        timestamptz NULL,
  -- The certificate expiry a "certificate expires soon" notice was sent for (once per certificate).
  tls_warned_expiry     timestamptz NULL,
  status_changed_at     timestamptz NULL,
  -- Claiming a due check moves this forward first (row-locked, SKIP LOCKED), so a crashed replica only delays it.
  next_check_at         timestamptz NOT NULL,
  created_by_type       text NOT NULL CHECK (created_by_type IN ('user', 'system')),
  created_by            text NULL,
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  CHECK (timeout_ms < interval_sec * 1000)
);
CREATE INDEX uptime_monitors_due_idx ON uptime_monitors (next_check_at) WHERE NOT paused;
CREATE INDEX uptime_monitors_project_idx ON uptime_monitors (project, created_at);
CREATE INDEX uptime_monitors_output_idx ON uptime_monitors (project, output_key) WHERE output_key IS NOT NULL;

-- One row per check. ok NULL: the result could not be decided (provider unreachable or not configured) — it does not
-- count for the uptime figure and does not change the status. Pruned after 30 days.
CREATE TABLE uptime_checks (
  id           bigserial PRIMARY KEY,
  monitor_id   uuid NOT NULL REFERENCES uptime_monitors (id) ON DELETE CASCADE,
  at           timestamptz NOT NULL,
  ok           boolean NULL,
  latency_ms   integer NULL CHECK (latency_ms IS NULL OR latency_ms >= 0),
  status_code  integer NULL,
  -- A fixed cause code (timeout, dns, address_refused, status, keyword, slow, tls, connect, provider_*, …).
  error        text NULL CHECK (error IS NULL OR error ~ '^[a-z_]{1,40}$'),
  detail       text NULL CHECK (detail IS NULL OR length(detail) <= 300)
);
CREATE INDEX uptime_checks_monitor_idx ON uptime_checks (monitor_id, at DESC);
CREATE INDEX uptime_checks_at_idx ON uptime_checks (at);

-- Hourly rollups (kept 90 days): maintained with every check.
CREATE TABLE uptime_rollups (
  monitor_id   uuid NOT NULL REFERENCES uptime_monitors (id) ON DELETE CASCADE,
  hour         timestamptz NOT NULL,
  checks       integer NOT NULL CHECK (checks >= 0),
  ok_checks    integer NOT NULL CHECK (ok_checks >= 0),
  latency_sum  bigint NOT NULL DEFAULT 0,
  latency_n    integer NOT NULL DEFAULT 0,
  latency_max  integer NULL,
  PRIMARY KEY (monitor_id, hour),
  CHECK (ok_checks <= checks)
);
CREATE INDEX uptime_rollups_hour_idx ON uptime_rollups (hour);

-- Down periods: opened when a monitor goes down, closed when it is up again.
CREATE TABLE uptime_incidents (
  id           uuid PRIMARY KEY,
  monitor_id   uuid NOT NULL REFERENCES uptime_monitors (id) ON DELETE CASCADE,
  project      text NOT NULL,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz NULL CHECK (ended_at IS NULL OR ended_at >= started_at),
  cause        text NOT NULL CHECK (cause ~ '^[a-z_]{1,40}$'),
  detail       text NULL CHECK (detail IS NULL OR length(detail) <= 300),
  -- The monitor was flapping when the incident opened (no notification was sent for it).
  suppressed   boolean NOT NULL DEFAULT false
);
CREATE INDEX uptime_incidents_monitor_idx ON uptime_incidents (monitor_id, started_at DESC);
CREATE UNIQUE INDEX uptime_incidents_open_idx ON uptime_incidents (monitor_id) WHERE ended_at IS NULL;

-- Per-project uptime settings: monitor every newly deployed site automatically (opt-in).
CREATE TABLE uptime_settings (
  project       text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  auto_monitor  boolean NOT NULL,
  -- Deploys that finished after this are considered (set when auto-monitoring is switched on).
  auto_since    timestamptz NULL,
  updated_by    uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL
);

-- Console notifications: a monitor went down / is up again.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed', 'deploy.succeeded', 'chat.watch', 'chat.note', 'monitor.down', 'monitor.up'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed', 'deploy.succeeded', 'chat.watch', 'chat.note', 'monitor.down', 'monitor.up'));

-- Chat: a watch can follow a monitor (down / up); the assistant can draft a monitor.
ALTER TABLE chat_watches DROP CONSTRAINT chat_watches_target_kind_check;
ALTER TABLE chat_watches ADD CONSTRAINT chat_watches_target_kind_check
  CHECK (target_kind IN ('job', 'workflow_run', 'automation', 'ops_action', 'approval', 'worker', 'draft',
                         'monitor'));
ALTER TABLE chat_watches DROP CONSTRAINT chat_watches_conditions_check;
ALTER TABLE chat_watches ADD CONSTRAINT chat_watches_conditions_check
  CHECK (cardinality(conditions) BETWEEN 1 AND 8
         AND conditions <@ ARRAY['finished', 'succeeded', 'failed', 'cancelled', 'approval_requested',
                                 'decided', 'online', 'offline', 'down', 'up']::text[]);
ALTER TABLE chat_drafts DROP CONSTRAINT chat_drafts_kind_check;
ALTER TABLE chat_drafts ADD CONSTRAINT chat_drafts_kind_check
  CHECK (kind IN ('job', 'workflow_run', 'worker_config', 'approval_decision', 'job_message', 'machine_task',
                  'tool_install', 'skill', 'automation', 'automation_change', 'ops_action', 'monitor'));
