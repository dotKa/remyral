-- p1-audit-schema: append-only, SHA-256 hash-chained audit log (threat model T-OPS-3).
-- Rows are written only through src/audit/audit.ts (AuditLog.record), which serialises appends with an
-- advisory transaction lock and links each row to its predecessor via prev_hash/hash.

CREATE TABLE audit_events (
  id          bigint PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  actor_type  text NOT NULL CHECK (actor_type IN ('user', 'worker', 'system', 'anonymous')),
  actor_id    text NULL CHECK (actor_id IS NULL OR length(actor_id) <= 200),
  action      text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  target      text NULL CHECK (target IS NULL OR length(target) <= 500),
  outcome     text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied', 'error')),
  ip          text NULL CHECK (ip IS NULL OR length(ip) <= 100),
  user_agent  text NULL CHECK (user_agent IS NULL OR length(user_agent) <= 500),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  prev_hash   bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash        bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);

CREATE SEQUENCE audit_events_id_seq AS bigint OWNED BY audit_events.id;

CREATE INDEX audit_events_occurred_at_idx ON audit_events (occurred_at);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_type, actor_id, occurred_at);
CREATE INDEX audit_events_action_idx ON audit_events (action, occurred_at);

-- Append-only at the database level: UPDATE, DELETE and TRUNCATE are rejected for every role,
-- including the table owner. (Dropping the trigger needs DDL rights; production runs the API with a
-- role that does not own the table — p1-data-services.)
CREATE FUNCTION audit_events_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_change();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject_change();

REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM PUBLIC;
