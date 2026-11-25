-- p15-services (docs/design/p15-services.md): Servisler — long-running processes a worker owns instead of a job (dev
-- servers, backends), with their own lifetime (TTL or until stopped), health, restart policy, optional Cloudflare tunnel
-- (quick, or named through the project's preview-link settings) and bounded logs on the worker. They hold no job slot.
-- The master keeps the desired state here and reconciles it with each worker's CAPABILITIES.services. Additive only
-- (rollback: the table stays unused; workers without `services-v1` never receive a service). Migration number 0120
-- (given in the brief); renumber at merge if needed.

CREATE TABLE services (
  id              uuid PRIMARY KEY,
  project         text NOT NULL REFERENCES projects (id),
  worker_id       text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  name            text NOT NULL CHECK (name ~ '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$'),
  -- The ServiceSpec the worker runs (@remana/protocol): plain env values and secret REFERENCES only, never a value.
  spec            jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object' AND octet_length(spec::text) <= 65536),
  revision        integer NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 1000000),
  desired         text NOT NULL CHECK (desired IN ('running', 'stopped', 'removed')),
  -- Reported by the worker (SERVICE_STATUS); `pending` until the worker answered.
  state           text NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending', 'starting', 'running', 'unhealthy', 'restarting', 'stopped', 'failed',
                                   'expired', 'refused')),
  health          text NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown', 'healthy', 'unhealthy', 'none')),
  detail          text NULL CHECK (detail IS NULL OR length(detail) <= 300),
  tunnel_mode     text NOT NULL CHECK (tunnel_mode IN ('none', 'quick', 'named')),
  tunnel_state    text NULL CHECK (tunnel_state IS NULL OR tunnel_state IN
                                   ('none', 'starting', 'running', 'failed', 'refused', 'stopped')),
  tunnel_detail   text NULL CHECK (tunnel_detail IS NULL OR length(tunnel_detail) <= 300),
  -- Named tunnels: the preview_tunnels row the master created for the service (ADR-0032 addendum).
  tunnel_id       uuid NULL,
  tunnel_protect  text NULL CHECK (tunnel_protect IS NULL OR tunnel_protect IN ('none', 'access', 'service-token')),
  tunnel_name     text NULL CHECK (tunnel_name IS NULL OR tunnel_name ~ '^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$'),
  url             text NULL CHECK (url IS NULL OR (url ~ '^https://[A-Za-z0-9.-]+(/.*)?$' AND length(url) <= 300)),
  pid             integer NULL CHECK (pid IS NULL OR pid > 0),
  started_at      timestamptz NULL,
  restarts        integer NOT NULL DEFAULT 0 CHECK (restarts >= 0),
  exit_code       integer NULL,
  cpu_percent     real NULL CHECK (cpu_percent IS NULL OR cpu_percent >= 0),
  memory_bytes    bigint NULL CHECK (memory_bytes IS NULL OR memory_bytes >= 0),
  -- The job whose worktree the service runs from (job → service hand-off), if any.
  source_job_id   uuid NULL REFERENCES jobs (id),
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'system')),
  created_by_id   text NOT NULL CHECK (length(created_by_id) BETWEEN 1 AND 128),
  created_via     text NOT NULL CHECK (created_via IN ('api', 'chat', 'job')),
  expires_at      timestamptz NULL,
  status_at       timestamptz NULL,
  healthy_at      timestamptz NULL,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  stopped_at      timestamptz NULL,
  stop_reason     text NULL CHECK (stop_reason IS NULL OR length(stop_reason) <= 300)
);
CREATE UNIQUE INDEX services_project_name ON services (project, name) WHERE desired <> 'removed';
CREATE INDEX services_worker_idx ON services (worker_id) WHERE desired <> 'removed';
CREATE INDEX services_project_idx ON services (project, created_at DESC);
CREATE INDEX services_expiry_idx ON services (expires_at) WHERE desired = 'running' AND expires_at IS NOT NULL;
CREATE INDEX services_job_idx ON services (source_job_id) WHERE source_job_id IS NOT NULL;

-- Named service tunnels are preview_tunnels rows owned by a service instead of a job.
ALTER TABLE preview_tunnels ADD COLUMN service_id uuid NULL REFERENCES services (id);
CREATE INDEX preview_tunnels_service_idx ON preview_tunnels (service_id) WHERE service_id IS NOT NULL;
ALTER TABLE services ADD CONSTRAINT services_tunnel_fk FOREIGN KEY (tunnel_id) REFERENCES preview_tunnels (id);

-- p15-watches hand-off: a `service_url` watch wakes when its service's state, health or URL changes.
CREATE FUNCTION remana_watch_services() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state OR NEW.health IS DISTINCT FROM OLD.health
     OR NEW.url IS DISTINCT FROM OLD.url OR NEW.desired IS DISTINCT FROM OLD.desired THEN
    PERFORM remana_watch_wake('service:' || NEW.id::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER chat_watches_services AFTER UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION remana_watch_services();

-- Chat draft kind `service_action` (start_service / stop_service / restart_service cards; run at once with the
-- p15-autonomy `execute` flag), appended to whatever the constraint allows now.
CREATE FUNCTION pg_temp.widen_check_0120(t text, c text, col text, extra text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  def text;
  vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = c AND conrelid = t::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint % not found', c;
  END IF;
  IF def ~ '\{' THEN
    vals := string_to_array(substring(def from '\{([^}]*)\}'), ',');
  ELSE
    SELECT array_agg(DISTINCT m[1]) INTO vals FROM regexp_matches(def, '''([A-Za-z0-9_.:-]+)''', 'g') AS m;
  END IF;
  IF coalesce(array_length(vals, 1), 0) < 2 THEN
    RAISE EXCEPTION 'could not read the values of %', c;
  END IF;
  vals := vals || extra;
  SELECT array_agg(DISTINCT v ORDER BY v) INTO vals FROM unnest(vals) AS v;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I = ANY (%L::text[]))', t, c, col, vals);
END
$$;

SELECT pg_temp.widen_check_0120('chat_drafts', 'chat_drafts_kind_check', 'kind', ARRAY['service_action']);
