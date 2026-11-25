-- p19-ide W2 (docs/design/p19-ide.md §3, §7, ADR-0066): "Tam IDE" — openvscode-server workspaces per (project, user,
-- name) on a Linux worker, reached through the master's IDE origin (`ide.<domain>`) over the STREAM_* plane.
--
--  ide_workspaces  the desired state the master keeps (reconciled with each worker's CAPABILITIES.ide, like services)
--                  and the last state the worker reported (IDE_STATUS). The files live on that worker.
--  ide_access      one-time tickets (60 s, single use) and the IDE origin's cookie sessions (15 min sliding, 8 h max),
--                  bound to a user, a workspace and the console session they came from — only SHA-256 hashes of the
--                  random values are stored; the console session's end removes them (cascade).
--  ide_references  "Sohbete ekle" from the IDE: pending chat references of a user (path + range only, never text),
--                  claimed by the console composer.
--
-- Additive. Rollback: an older master ignores the tables (workers without `ide-v1` never get an IDE); to remove:
-- DROP TABLE ide_references, ide_access, ide_workspaces;

CREATE TABLE ide_workspaces (
  id               uuid PRIMARY KEY,
  project          text NOT NULL REFERENCES projects (id),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  worker_id        text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  name             text NOT NULL CHECK (name ~ '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$'),
  source_kind      text NOT NULL CHECK (source_kind IN ('repository', 'files')),
  -- Repository workspaces: the IDE branch (`remyral/ide/<user>/<name>`) and where it started.
  branch           text NULL CHECK (branch IS NULL OR (length(branch) <= 80 AND branch LIKE 'remyral/ide/%')),
  base_ref         text NULL CHECK (base_ref IS NULL OR length(base_ref) <= 256),
  -- Files workspaces: the job whose kept working dir seeded it (copied once on the machine).
  seed_job_id      uuid NULL REFERENCES jobs (id) ON DELETE SET NULL,
  -- The IdeSpec the worker runs (@remyral/protocol); no secret in it.
  spec             jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object' AND octet_length(spec::text) <= 16384),
  revision         integer NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 1000000),
  desired          text NOT NULL CHECK (desired IN ('running', 'stopped', 'deleted')),
  -- Reported by the worker (IDE_STATUS); `pending` until it answered.
  state            text NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending', 'preparing', 'starting', 'running', 'stopped', 'failed', 'refused',
                                    'removed')),
  detail           text NULL CHECK (detail IS NULL OR length(detail) <= 300),
  stop_reason      text NULL CHECK (stop_reason IS NULL OR stop_reason IN
                                    ('requested', 'idle', 'memory', 'worker', 'exited', 'error')),
  head             text NULL CHECK (head IS NULL OR head ~ '^[0-9a-f]{40}$'),
  memory_bytes     bigint NULL CHECK (memory_bytes IS NULL OR memory_bytes >= 0),
  cpu_percent      real NULL CHECK (cpu_percent IS NULL OR cpu_percent >= 0),
  pull_request_url text NULL CHECK (pull_request_url IS NULL OR (pull_request_url ~ '^https://' AND length(pull_request_url) <= 2048)),
  started_at       timestamptz NULL,
  last_activity_at timestamptz NULL,
  last_pushed_at   timestamptz NULL,
  status_at        timestamptz NULL,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  stopped_at       timestamptz NULL,
  deleted_at       timestamptz NULL
);
CREATE UNIQUE INDEX ide_workspaces_name ON ide_workspaces (project, user_id, name) WHERE desired <> 'deleted';
CREATE INDEX ide_workspaces_worker_idx ON ide_workspaces (worker_id) WHERE desired <> 'deleted';
CREATE INDEX ide_workspaces_user_idx ON ide_workspaces (user_id, created_at DESC);
CREATE INDEX ide_workspaces_running_idx ON ide_workspaces (status_at) WHERE desired = 'running';

CREATE TABLE ide_access (
  -- SHA-256 of the 256-bit random ticket / cookie value; the value itself exists only in the URL / cookie.
  token_hash     bytea PRIMARY KEY CHECK (length(token_hash) = 32),
  kind           text NOT NULL CHECK (kind IN ('ticket', 'session')),
  workspace_id   uuid NOT NULL REFERENCES ide_workspaces (id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The console session that asked for the ticket (sessions.id_hash; a step-up rotation moves it along).
  session_hash   bytea NOT NULL REFERENCES sessions (id_hash) ON DELETE CASCADE,
  ip             text NULL CHECK (ip IS NULL OR length(ip) <= 64),
  created_at     timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  max_expires_at timestamptz NOT NULL,
  CHECK (expires_at <= max_expires_at)
);
CREATE INDEX ide_access_workspace_idx ON ide_access (workspace_id);
CREATE INDEX ide_access_session_idx ON ide_access (session_hash);
CREATE INDEX ide_access_expiry_idx ON ide_access (max_expires_at);

CREATE TABLE ide_references (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES ide_workspaces (id) ON DELETE CASCADE,
  project      text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- The `code` mention id: `ide:<workspace id>:<start>-<end>:<path>` (re-read from the machine at send time).
  ref_id       text NOT NULL CHECK (length(ref_id) BETWEEN 1 AND 320),
  label        text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  created_at   timestamptz NOT NULL,
  claimed_at   timestamptz NULL
);
CREATE INDEX ide_references_pending_idx ON ide_references (user_id, created_at) WHERE claimed_at IS NULL;
