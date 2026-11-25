-- p5-managed-workers (ADR-0015, docs/design/p5-managed-workers.md): the master is the source of truth for a
-- worker's operational configuration. Per worker: an append-only, gap-free history of generations (what the
-- admin chose = `spec`, what the worker receives = `document`, with project ids resolved to the repository URL
-- of each project's registered git configuration) and a pointer to the desired generation plus delivery state.
-- The worker's own report (applied generation, effective configuration, local ceiling, blocked items, last
-- rejection) is stored on `workers` because unmanaged workers report too ("take over from local file").
-- Rows are written only through src/worker-config/* (WorkerConfigService); triggers are defence in depth
-- (SQLSTATE RA000 like 0015).

CREATE TABLE worker_config_versions (
  worker_id      text NOT NULL REFERENCES workers (id),
  generation     integer NOT NULL CHECK (generation >= 1),
  -- @remana/protocol WorkerConfigSpec (project ids, no URLs, no credential values).
  spec           jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
  -- @remana/protocol WorkerConfigDocument as delivered (validated by the service).
  document       jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  -- Lowercase hex SHA-256 of the canonical JSON of `document` (workerConfigHash).
  document_hash  text NOT NULL CHECK (document_hash ~ '^[a-f0-9]{64}$'),
  -- edit: single-worker save; bulk: bulk apply; project: assignment from the project side; rollback;
  -- adopt: taken over from the worker's local file; repository: a project's registered repository changed.
  cause          text NOT NULL CHECK (cause IN ('edit', 'bulk', 'project', 'rollback', 'adopt', 'repository')),
  rollback_of    integer NULL CHECK (rollback_of IS NULL OR (rollback_of >= 1 AND rollback_of < generation)),
  change_note    text NULL CHECK (change_note IS NULL OR length(change_note) <= 1000),
  created_at     timestamptz NOT NULL,
  -- NULL for system generations (cause 'repository').
  created_by     uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  PRIMARY KEY (worker_id, generation)
);

CREATE FUNCTION worker_config_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT max(generation) INTO latest FROM worker_config_versions WHERE worker_id = NEW.worker_id;
    IF NEW.generation <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'worker % config generation must be %', NEW.worker_id, COALESCE(latest, 0) + 1
        USING ERRCODE = 'RA000';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'worker_config_versions is append-only (% rejected)', TG_OP USING ERRCODE = 'RA000';
END;
$$;

CREATE TRIGGER worker_config_versions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON worker_config_versions
  FOR EACH ROW EXECUTE FUNCTION worker_config_versions_guard();

CREATE TABLE worker_configs (
  worker_id             text PRIMARY KEY REFERENCES workers (id),
  -- The desired generation (the worker should apply exactly this one).
  generation            integer NOT NULL CHECK (generation >= 1),
  updated_at            timestamptz NOT NULL,
  updated_by            uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  -- Last APPLY_WORKER_CONFIG sent (control message; re-sent when a session reports another generation).
  delivered_generation  integer NULL CHECK (delivered_generation IS NULL OR delivered_generation >= 1),
  delivered_at          timestamptz NULL,
  CONSTRAINT worker_configs_generation_fk FOREIGN KEY (worker_id, generation)
    REFERENCES worker_config_versions (worker_id, generation) DEFERRABLE INITIALLY DEFERRED
);

-- The worker's latest WorkerConfigReport (CAPABILITIES.workerConfig / WORKER_CONFIG_STATUS), as reported.
ALTER TABLE workers
  ADD COLUMN config_report jsonb NULL CHECK (config_report IS NULL OR jsonb_typeof(config_report) = 'object'),
  ADD COLUMN config_reported_at timestamptz NULL;

-- Admins are told about every configuration change and every refused configuration (ADR-0015 §7).
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config'));

ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config'));
