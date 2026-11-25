-- p15-watches (docs/design/p15-watches.md): Takipler — deterministic watches. A chat watch of kind `check` carries a
-- typed condition (`spec`, @remana/protocol WatchCheckCondition) the master evaluates by itself: event kinds when their
-- rows change (the triggers below notify `remana_watch` with the watch's subject, only when an active watch has it),
-- external kinds (`http`, `worker_probe`) as function jobs on workers on a backoff schedule (`next_check_at`,
-- `pending_job_id`). No check, timeout or delivery starts an assistant turn. Additive only (rollback: the columns and
-- the table stay unused; drop the triggers to stop the notifications). Migration number 0119 (given in the brief);
-- renumber at merge if needed.

-- 1. The `check` kind: target_ref `chk_<16 hex>` (a digest of the condition, so asking twice updates the same watch),
--    condition `met`.
ALTER TABLE chat_watches DROP CONSTRAINT chat_watches_target_kind_check;
ALTER TABLE chat_watches ADD CONSTRAINT chat_watches_target_kind_check
  CHECK (target_kind IN ('job', 'workflow_run', 'automation', 'ops_action', 'approval', 'worker', 'draft',
                         'monitor', 'check'));
ALTER TABLE chat_watches DROP CONSTRAINT chat_watches_conditions_check;
ALTER TABLE chat_watches ADD CONSTRAINT chat_watches_conditions_check
  CHECK (cardinality(conditions) BETWEEN 1 AND 8
         AND conditions <@ ARRAY['finished', 'succeeded', 'failed', 'cancelled', 'approval_requested',
                                 'decided', 'online', 'offline', 'down', 'up', 'met']::text[]);
-- The unnamed checks of 0061 on target_ref / target_uuid (their generated names differ between installations).
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'chat_watches'::regclass AND contype = 'c'
       AND (pg_get_constraintdef(oid) LIKE '%target_ref%' OR pg_get_constraintdef(oid) LIKE '%target_uuid%')
  LOOP
    EXECUTE format('ALTER TABLE chat_watches DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE chat_watches ADD CONSTRAINT chat_watches_target_ref_check
  CHECK (target_ref IS NULL OR target_ref ~ '^(wrk_[a-z2-7]{26}|chk_[0-9a-f]{16})$');
ALTER TABLE chat_watches ADD CONSTRAINT chat_watches_ref_kind_check
  CHECK ((target_kind IN ('worker', 'check')) = (target_ref IS NOT NULL));
ALTER TABLE chat_watches ADD CONSTRAINT chat_watches_uuid_kind_check
  CHECK ((target_kind IN ('worker', 'check')) = (target_uuid IS NULL));

-- 2. Check state.
ALTER TABLE chat_watches
  -- The condition (WatchCheckCondition, resolved: machine names → ids), the optional `then` card, the polling base.
  ADD COLUMN spec           jsonb NULL CHECK (spec IS NULL OR (jsonb_typeof(spec) = 'object'
                                              AND octet_length(spec::text) <= 16384)),
  ADD COLUMN then_action    jsonb NULL CHECK (then_action IS NULL OR (jsonb_typeof(then_action) = 'object'
                                              AND octet_length(then_action::text) <= 16384)),
  -- What the triggers notify (`job:<id>`, `jobev:<id>`, `jobout:<id>`, `run:<id>`, `worker:<id>`, `tunnel:<id>`,
  -- `pvjob:<job>`, `pvname:<project>:<name>`, `service:<id>`); null for purely polled checks.
  ADD COLUMN subject        text NULL CHECK (subject IS NULL OR subject ~
                                              '^(job|jobev|jobout|run|worker|tunnel|pvjob|pvname|service):[A-Za-z0-9_.:-]{1,200}$'),
  ADD COLUMN every_sec      integer NULL CHECK (every_sec IS NULL OR every_sec BETWEEN 30 AND 900),
  ADD COLUMN next_check_at  timestamptz NULL,
  -- The function job of the check in flight (its end wakes the watch through the jobs trigger).
  ADD COLUMN pending_job_id uuid NULL,
  ADD COLUMN check_count    integer NOT NULL DEFAULT 0 CHECK (check_count >= 0),
  -- Unmet checks in a row (the polling backoff).
  ADD COLUMN unmet_streak   integer NOT NULL DEFAULT 0 CHECK (unmet_streak >= 0),
  ADD COLUMN last_check     jsonb NULL CHECK (last_check IS NULL OR (jsonb_typeof(last_check) = 'object'
                                              AND octet_length(last_check::text) <= 8192)),
  -- What the watch delivered when it was met (URL, status, value).
  ADD COLUMN result         jsonb NULL CHECK (result IS NULL OR octet_length(result::text) <= 8192);
ALTER TABLE chat_watches ADD CONSTRAINT chat_watches_check_spec_check
  CHECK ((target_kind = 'check') = (spec IS NOT NULL));
CREATE INDEX chat_watches_subject_idx ON chat_watches (subject) WHERE state = 'active' AND subject IS NOT NULL;
CREATE INDEX chat_watches_due_idx ON chat_watches (next_check_at)
  WHERE state = 'active' AND next_check_at IS NOT NULL;
CREATE INDEX chat_watches_pending_job_idx ON chat_watches (pending_job_id)
  WHERE state = 'active' AND pending_job_id IS NOT NULL;

-- 3. Check history (the last ones per watch; the service keeps at most 20 and only rows whose result changed).
CREATE TABLE chat_watch_checks (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  watch_id  uuid NOT NULL REFERENCES chat_watches (id) ON DELETE CASCADE,
  at        timestamptz NOT NULL,
  mode      text NOT NULL CHECK (mode IN ('dry', 'event', 'poll', 'reconcile')),
  met       boolean NOT NULL,
  summary   text NOT NULL CHECK (length(summary) <= 500),
  value     jsonb NULL CHECK (value IS NULL OR octet_length(value::text) <= 4096),
  error     text NULL CHECK (error IS NULL OR error ~ '^[a-z_]{1,80}$'),
  job_id    uuid NULL,
  worker_id text NULL CHECK (worker_id IS NULL OR worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$')
);
CREATE INDEX chat_watch_checks_watch_idx ON chat_watch_checks (watch_id, id DESC);

-- 4. Event triggers: notify `remana_watch` with the subject, only when an active watch has it (partial index; the
--    notification is transactional: listeners hear it once the change committed, on every master replica).
CREATE FUNCTION remana_watch_wake(subj text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM chat_watches WHERE state = 'active' AND subject = subj) THEN
    PERFORM pg_notify('remana_watch', subj);
  END IF;
END $$;

CREATE FUNCTION remana_watch_jobs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    PERFORM remana_watch_wake('job:' || NEW.id::text);
    IF EXISTS (SELECT 1 FROM chat_watches WHERE state = 'active' AND pending_job_id = NEW.id) THEN
      PERFORM pg_notify('remana_watch', 'check:' || NEW.id::text);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER chat_watches_jobs AFTER UPDATE OF state ON jobs FOR EACH ROW EXECUTE FUNCTION remana_watch_jobs();

-- needs_you: a new / decided approval request or question of a job.
CREATE FUNCTION remana_watch_job_ref() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.job_id IS NOT NULL THEN
    PERFORM remana_watch_wake('job:' || NEW.job_id::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER chat_watches_approvals AFTER INSERT OR UPDATE OF status ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION remana_watch_job_ref();
CREATE TRIGGER chat_watches_questions AFTER INSERT OR UPDATE OF state ON user_questions
  FOR EACH ROW EXECUTE FUNCTION remana_watch_job_ref();

-- job_event: statement level (a batch of events wakes each job once).
CREATE FUNCTION remana_watch_job_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j uuid;
BEGIN
  FOR j IN SELECT DISTINCT job_id FROM new_events LOOP
    PERFORM remana_watch_wake('jobev:' || j::text);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER chat_watches_job_events AFTER INSERT ON job_events REFERENCING NEW TABLE AS new_events
  FOR EACH STATEMENT EXECUTE FUNCTION remana_watch_job_events();

CREATE FUNCTION remana_watch_job_artifacts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j uuid;
BEGIN
  FOR j IN SELECT DISTINCT job_id FROM new_artifacts LOOP
    PERFORM remana_watch_wake('jobout:' || j::text);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER chat_watches_job_artifacts AFTER INSERT ON job_artifacts REFERENCING NEW TABLE AS new_artifacts
  FOR EACH STATEMENT EXECUTE FUNCTION remana_watch_job_artifacts();

CREATE FUNCTION remana_watch_runs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    PERFORM remana_watch_wake('run:' || NEW.id::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER chat_watches_runs AFTER UPDATE OF state ON workflow_runs FOR EACH ROW EXECUTE FUNCTION remana_watch_runs();

CREATE FUNCTION remana_watch_node_runs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.state IS DISTINCT FROM OLD.state THEN
    PERFORM remana_watch_wake('run:' || NEW.run_id::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER chat_watches_node_runs AFTER INSERT OR UPDATE OF state ON workflow_node_runs
  FOR EACH ROW EXECUTE FUNCTION remana_watch_node_runs();

CREATE FUNCTION remana_watch_workers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    PERFORM remana_watch_wake('worker:' || NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER chat_watches_workers AFTER UPDATE OF state ON workers FOR EACH ROW EXECUTE FUNCTION remana_watch_workers();

CREATE FUNCTION remana_watch_worker_runtimes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM remana_watch_wake('worker:' || NEW.worker_id);
  RETURN NULL;
END $$;
CREATE TRIGGER chat_watches_worker_runtimes AFTER INSERT OR UPDATE ON worker_runtimes
  FOR EACH ROW EXECUTE FUNCTION remana_watch_worker_runtimes();

CREATE FUNCTION remana_watch_tunnels() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.state IS DISTINCT FROM OLD.state
     OR NEW.connector_state IS DISTINCT FROM OLD.connector_state OR NEW.job_id IS DISTINCT FROM OLD.job_id THEN
    PERFORM remana_watch_wake('tunnel:' || NEW.id::text);
    PERFORM remana_watch_wake('pvname:' || NEW.project || ':' || NEW.name);
    IF NEW.job_id IS NOT NULL THEN
      PERFORM remana_watch_wake('pvjob:' || NEW.job_id::text);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER chat_watches_tunnels AFTER INSERT OR UPDATE ON preview_tunnels
  FOR EACH ROW EXECUTE FUNCTION remana_watch_tunnels();
