-- p5-search-audit: indexes for the audit explorer and the jobs read API (docs/design/p5-search-audit.md).
-- Read-side only: no table, constraint or trigger of the audit/job tables changes.

-- Trigram matching for substring search over identifiers (UUIDs, dotted actions, worker ids). pg_trgm is a
-- trusted extension (PostgreSQL >= 13): a non-superuser database owner may create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The searchable text of an audit event (action, actor id, target, metadata). IMMUTABLE so the expression
-- index and the query use the identical expression; metadata is searched exactly as stored (already redacted
-- at write time).
CREATE FUNCTION audit_search_text(action text, actor_id text, target text, metadata jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT action || ' ' || coalesce(actor_id, '') || ' ' || coalesce(target, '') || ' ' || metadata::text
$$;

CREATE INDEX audit_events_search_trgm_idx
  ON audit_events USING gin (audit_search_text(action, actor_id, target, metadata) gin_trgm_ops);
CREATE INDEX audit_events_target_idx ON audit_events (target, id);
CREATE INDEX audit_events_outcome_idx ON audit_events (outcome, id);

-- Jobs list: keyset on (created_at, id), runtime filter, worker filter.
CREATE INDEX jobs_created_keyset_idx ON jobs (created_at DESC, id DESC);
CREATE INDEX jobs_runtime_idx ON jobs ((spec ->> 'runtime'), created_at);
CREATE INDEX job_attempts_worker_job_idx ON job_attempts (worker_id, job_id);
