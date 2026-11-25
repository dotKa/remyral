-- p4-job-store (ADR-0003, ADR-0004): jobs and their state machine, attempts, append-only transition
-- history, dependency DAG, fenced leases and the transactional outbox. Rows are written only through
-- src/jobs/store.ts (JobStore); the triggers below are defence in depth for the invariants it relies on.
-- Design: docs/design/p4-job-store.md. State machine: packages/scheduler (job_state mirrors JOB_STATES).

CREATE TYPE job_state AS ENUM (
  'DRAFT', 'QUEUED', 'RESERVED', 'STARTING', 'RUNNING', 'VERIFYING', 'AWAITING_APPROVAL', 'SUCCEEDED',
  'RETRY_WAIT', 'FAILED', 'CANCELLING', 'CANCELLED', 'BLOCKED', 'LOST'
);

-- Every invariant violation raised by the triggers below uses SQLSTATE 'RA000'
-- (dependency cycles use 'RA001'), so the store can tell them apart from ordinary constraint errors.

CREATE TABLE jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Project identifier (projects table arrives with p5; until then a protocol-style identifier).
  project            text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- Validated against @remana/protocol JobSpec by the store before insert.
  spec               jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
  state              job_state NOT NULL DEFAULT 'DRAFT',
  priority           smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  -- Optimistic concurrency: every UPDATE must increment version by exactly one (trigger below).
  version            integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- Last fencing epoch issued for this job (ADR-0004); never decreases.
  lease_epoch        integer NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  current_attempt_id uuid NULL,
  created_by_type    text NOT NULL CHECK (created_by_type IN ('user', 'worker', 'system')),
  created_by_id      text NULL CHECK (created_by_id IS NULL OR length(created_by_id) <= 200),
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  state_changed_at   timestamptz NOT NULL
);

CREATE INDEX jobs_queued_idx ON jobs (priority DESC, created_at) WHERE state = 'QUEUED';
CREATE INDEX jobs_state_idx ON jobs (state, state_changed_at);
CREATE INDEX jobs_project_idx ON jobs (project, created_at);

CREATE TABLE job_attempts (
  id         uuid PRIMARY KEY,
  job_id     uuid NOT NULL REFERENCES jobs (id),
  number     integer NOT NULL CHECK (number >= 1),
  worker_id  text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- active: worker holds the attempt; lost: lease expired, awaiting reconciliation; ended: has an outcome.
  state      text NOT NULL CHECK (state IN ('active', 'lost', 'ended')),
  outcome    text NULL CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'retry', 'declined')),
  started_at timestamptz NOT NULL,
  ended_at   timestamptz NULL,
  UNIQUE (job_id, number),
  UNIQUE (id, job_id),
  CHECK ((state = 'ended') = (outcome IS NOT NULL)),
  CHECK ((state = 'ended') = (ended_at IS NOT NULL))
);

-- At most one open attempt per job.
CREATE UNIQUE INDEX job_attempts_one_open_idx ON job_attempts (job_id) WHERE state <> 'ended';
CREATE INDEX job_attempts_worker_open_idx ON job_attempts (worker_id) WHERE state <> 'ended';

ALTER TABLE jobs
  ADD CONSTRAINT jobs_current_attempt_fk FOREIGN KEY (current_attempt_id, id)
  REFERENCES job_attempts (id, job_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE leases (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id         uuid NOT NULL REFERENCES jobs (id),
  attempt_id     uuid NOT NULL,
  worker_id      text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- Fencing token: strictly increasing per job (ADR-0004 §1).
  epoch          integer NOT NULL CHECK (epoch >= 1),
  acquired_at    timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  released_at    timestamptz NULL,
  release_reason text NULL CHECK (release_reason IS NULL OR release_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  FOREIGN KEY (attempt_id, job_id) REFERENCES job_attempts (id, job_id),
  UNIQUE (job_id, epoch),
  CHECK (expires_at > acquired_at),
  CHECK ((released_at IS NULL) = (release_reason IS NULL))
);

-- At most one active (unreleased) lease per job.
CREATE UNIQUE INDEX leases_one_active_per_job_idx ON leases (job_id) WHERE released_at IS NULL;
CREATE INDEX leases_active_expiry_idx ON leases (expires_at) WHERE released_at IS NULL;
CREATE INDEX leases_worker_active_idx ON leases (worker_id) WHERE released_at IS NULL;

-- Append-only transition history (protected like audit_events, T-OPS-3).
CREATE TABLE job_transitions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id      uuid NOT NULL REFERENCES jobs (id),
  -- Job version after this transition; (job_id, version) orders a job's history without gaps.
  version     integer NOT NULL CHECK (version >= 1),
  from_state  job_state NULL,
  to_state    job_state NOT NULL,
  trigger     text NOT NULL CHECK (trigger ~ '^[a-z][a-z_]{0,63}$'),
  actor_type  text NOT NULL CHECK (actor_type IN ('user', 'worker', 'system')),
  actor_id    text NULL CHECK (actor_id IS NULL OR length(actor_id) <= 200),
  reason      text NULL CHECK (reason IS NULL OR length(reason) <= 1000),
  attempt_id  uuid NULL,
  epoch       integer NULL CHECK (epoch IS NULL OR epoch >= 1),
  occurred_at timestamptz NOT NULL,
  UNIQUE (job_id, version),
  CHECK ((from_state IS NULL) = (trigger = 'create'))
);

CREATE INDEX job_transitions_occurred_at_idx ON job_transitions (occurred_at);

-- Dependency DAG: job_id runs only after depends_on_job_id succeeded.
CREATE TABLE job_dependencies (
  job_id            uuid NOT NULL REFERENCES jobs (id),
  depends_on_job_id uuid NOT NULL REFERENCES jobs (id),
  created_at        timestamptz NOT NULL,
  PRIMARY KEY (job_id, depends_on_job_id),
  CHECK (job_id <> depends_on_job_id)
);

CREATE INDEX job_dependencies_depends_on_idx ON job_dependencies (depends_on_job_id);

-- Transactional outbox (ADR-0003 §1): written in the same transaction as the state change; the
-- dispatcher (p4-dispatch) relays undispatched rows in id order and marks them dispatched.
CREATE TABLE outbox (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic         text NOT NULL CHECK (topic ~ '^[a-z][a-z0-9_.]{0,99}$'),
  job_id        uuid NULL REFERENCES jobs (id),
  payload       jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at    timestamptz NOT NULL,
  dispatched_at timestamptz NULL
);

CREATE INDEX outbox_pending_idx ON outbox (id) WHERE dispatched_at IS NULL;
CREATE INDEX outbox_job_idx ON outbox (job_id, id);

---------------------------------------------------------------------------------------------------
-- Invariant triggers
---------------------------------------------------------------------------------------------------

CREATE FUNCTION jobs_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'job % is in terminal state % and immutable', OLD.id, OLD.state USING ERRCODE = 'RA000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'job % update must increment version by one', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF NEW.lease_epoch < OLD.lease_epoch THEN
    RAISE EXCEPTION 'job % lease epoch must not decrease', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.project <> OLD.project OR NEW.created_by_type <> OLD.created_by_type
     OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'job % identity columns are immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF NEW.spec <> OLD.spec AND OLD.state <> 'DRAFT' THEN
    RAISE EXCEPTION 'job % spec is immutable after submission', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER jobs_guard_update BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION jobs_guard_update();

CREATE FUNCTION job_attempts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'job_attempts rows cannot be removed (% rejected)', TG_OP USING ERRCODE = 'RA000';
  END IF;
  IF OLD.state = 'ended' THEN
    RAISE EXCEPTION 'attempt % has ended and is immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.job_id <> OLD.job_id OR NEW.number <> OLD.number OR NEW.worker_id <> OLD.worker_id
     OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'attempt % identity columns are immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_attempts_guard_update BEFORE UPDATE OR DELETE ON job_attempts
  FOR EACH ROW EXECUTE FUNCTION job_attempts_guard();
CREATE TRIGGER job_attempts_guard_truncate BEFORE TRUNCATE ON job_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION job_attempts_guard();

CREATE FUNCTION leases_guard_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  issued integer;
  holder text;
BEGIN
  SELECT lease_epoch INTO issued FROM jobs WHERE id = NEW.job_id;
  IF issued IS DISTINCT FROM NEW.epoch THEN
    RAISE EXCEPTION 'lease epoch % does not match the epoch issued for job %', NEW.epoch, NEW.job_id
      USING ERRCODE = 'RA000';
  END IF;
  IF EXISTS (SELECT 1 FROM leases WHERE job_id = NEW.job_id AND epoch >= NEW.epoch) THEN
    RAISE EXCEPTION 'lease epoch % for job % is not greater than every earlier epoch', NEW.epoch, NEW.job_id
      USING ERRCODE = 'RA000';
  END IF;
  SELECT worker_id INTO holder FROM job_attempts WHERE id = NEW.attempt_id;
  IF holder IS DISTINCT FROM NEW.worker_id THEN
    RAISE EXCEPTION 'lease worker does not match attempt worker' USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER leases_guard_insert BEFORE INSERT ON leases FOR EACH ROW EXECUTE FUNCTION leases_guard_insert();

CREATE FUNCTION leases_guard_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'leases rows cannot be removed (% rejected)', TG_OP USING ERRCODE = 'RA000';
  END IF;
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'lease % (epoch %) is released and immutable', OLD.id, OLD.epoch USING ERRCODE = 'RA000';
  END IF;
  IF NEW.job_id <> OLD.job_id OR NEW.attempt_id <> OLD.attempt_id OR NEW.worker_id <> OLD.worker_id
     OR NEW.epoch <> OLD.epoch OR NEW.acquired_at <> OLD.acquired_at THEN
    RAISE EXCEPTION 'lease % identity columns are immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER leases_guard_update BEFORE UPDATE OR DELETE ON leases
  FOR EACH ROW EXECUTE FUNCTION leases_guard_change();
CREATE TRIGGER leases_guard_truncate BEFORE TRUNCATE ON leases
  FOR EACH STATEMENT EXECUTE FUNCTION leases_guard_change();

CREATE FUNCTION job_transitions_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'job_transitions is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER job_transitions_no_update_delete BEFORE UPDATE OR DELETE ON job_transitions
  FOR EACH ROW EXECUTE FUNCTION job_transitions_reject_change();
CREATE TRIGGER job_transitions_no_truncate BEFORE TRUNCATE ON job_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION job_transitions_reject_change();

REVOKE UPDATE, DELETE, TRUNCATE ON job_transitions FROM PUBLIC;

-- Cycle prevention: an edge job -> dep closes a cycle iff dep already (transitively) depends on job.
-- A transaction-scoped advisory lock serialises edge inserts so two concurrent inserts cannot each miss
-- the other's edge (each statement in this VOLATILE function takes a fresh snapshot after the lock).
CREATE FUNCTION job_dependencies_guard_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(117026624660848); -- 'jobdep' in ASCII
  IF EXISTS (
    WITH RECURSIVE reach (id) AS (
      SELECT d.depends_on_job_id FROM job_dependencies d WHERE d.job_id = NEW.depends_on_job_id
      UNION
      SELECT d.depends_on_job_id FROM job_dependencies d JOIN reach r ON d.job_id = r.id
    )
    SELECT 1 FROM reach WHERE id = NEW.job_id
  ) THEN
    RAISE EXCEPTION 'dependency % -> % would create a cycle', NEW.job_id, NEW.depends_on_job_id
      USING ERRCODE = 'RA001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_dependencies_guard_insert BEFORE INSERT ON job_dependencies
  FOR EACH ROW EXECUTE FUNCTION job_dependencies_guard_insert();

CREATE FUNCTION job_dependencies_reject_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'job_dependencies edges are immutable (UPDATE rejected)' USING ERRCODE = 'RA000';
END;
$$;

CREATE TRIGGER job_dependencies_no_update BEFORE UPDATE ON job_dependencies
  FOR EACH ROW EXECUTE FUNCTION job_dependencies_reject_update();

-- Outbox rows are immutable except for marking them dispatched once; only dispatched rows may be pruned.
CREATE FUNCTION outbox_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'outbox cannot be truncated' USING ERRCODE = 'RA000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.dispatched_at IS NULL THEN
      RAISE EXCEPTION 'outbox row % has not been dispatched and cannot be deleted', OLD.id USING ERRCODE = 'RA000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.dispatched_at IS NOT NULL OR NEW.dispatched_at IS NULL OR NEW.id <> OLD.id OR NEW.topic <> OLD.topic
     OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.payload <> OLD.payload OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'outbox row % may only be marked dispatched once', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbox_guard_change BEFORE UPDATE OR DELETE ON outbox FOR EACH ROW EXECUTE FUNCTION outbox_guard();
CREATE TRIGGER outbox_guard_truncate BEFORE TRUNCATE ON outbox FOR EACH STATEMENT EXECUTE FUNCTION outbox_guard();
