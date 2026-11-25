-- p6-cost (ADR-0008 cost provenance, ADR-0014 subscription runs, acceptance A-UX-4): append-only usage
-- records, a versioned admin-maintained price table, budget definitions and their threshold alerts.
-- Rows are written only through src/usage (UsageStore). Triggers are defence in depth (SQLSTATE RA000),
-- like the job tables in 0003. Design: docs/design/p6-cost.md.

---------------------------------------------------------------------------------------------------
-- Usage records: one row per `usage` agent event (an increment). Append-only.
---------------------------------------------------------------------------------------------------

CREATE TABLE usage_records (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id             uuid NOT NULL REFERENCES jobs (id),
  attempt_id         uuid NOT NULL,
  worker_id          text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- Denormalised from the job at ingestion so summaries need no join (jobs.project is immutable).
  project            text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  runtime            text NOT NULL CHECK (runtime IN ('openhands', 'claude-code', 'codex', 'pi', 'opencode')),
  runtime_version    text NULL CHECK (runtime_version IS NULL OR length(runtime_version) BETWEEN 1 AND 64),
  -- NULL = not reported (shown as a gap, never guessed).
  provider           text NULL CHECK (provider IS NULL OR provider ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  model              text NULL CHECK (model IS NULL OR model ~ '^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$'),
  -- ADR-0014: 'secret-ref' (API key) or 'local-login' (subscription: no per-run dollar cost). NULL = unknown.
  auth_mode          text NULL CHECK (auth_mode IS NULL OR auth_mode IN ('secret-ref', 'local-login')),
  input_tokens       bigint NULL CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens      bigint NULL CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens  bigint NULL CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens bigint NULL CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  turns              integer NULL CHECK (turns IS NULL OR turns >= 0),
  wall_time_ms       bigint NULL CHECK (wall_time_ms IS NULL OR wall_time_ms >= 0),
  -- Dollar value and provenance exactly as the event reported them (ADR-0008). The cost shown to users
  -- is derived at read time (reported / estimated from the price table / unknown / subscription).
  cost_usd           numeric(20, 9) NULL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  provenance         text NOT NULL CHECK (provenance IN ('reported-by-runtime', 'estimated-from-tokens', 'unknown')),
  -- Idempotency key: the EVENT envelope messageId. One row per (attempt, source event).
  source_event_id    text NOT NULL CHECK (source_event_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- sha256 of the normalised event: a replay with different content is detected, never applied.
  payload_hash       text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  recorded_at        timestamptz NOT NULL,
  FOREIGN KEY (attempt_id, job_id) REFERENCES job_attempts (id, job_id),
  UNIQUE (attempt_id, source_event_id)
);

CREATE INDEX usage_records_recorded_idx ON usage_records (recorded_at DESC, id DESC);
CREATE INDEX usage_records_project_idx ON usage_records (project, recorded_at);
CREATE INDEX usage_records_worker_idx ON usage_records (worker_id, recorded_at);
CREATE INDEX usage_records_runtime_idx ON usage_records (runtime, recorded_at);
CREATE INDEX usage_records_provider_idx ON usage_records (provider, model, recorded_at);
CREATE INDEX usage_records_job_idx ON usage_records (job_id, id);

CREATE FUNCTION usage_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'RA000';
END;
$$;

CREATE TRIGGER usage_records_no_update_delete
  BEFORE UPDATE OR DELETE ON usage_records
  FOR EACH ROW EXECUTE FUNCTION usage_reject_change();
CREATE TRIGGER usage_records_no_truncate
  BEFORE TRUNCATE ON usage_records
  FOR EACH STATEMENT EXECUTE FUNCTION usage_reject_change();

---------------------------------------------------------------------------------------------------
-- Price table: every edit is a complete new version (append-only). The current table is the highest
-- version; version 0 (no row) is the empty table the platform ships with — no prices are invented.
---------------------------------------------------------------------------------------------------

CREATE TABLE usage_price_tables (
  version     integer PRIMARY KEY CHECK (version >= 1),
  note        text NULL CHECK (note IS NULL OR length(note) <= 1000),
  entry_count integer NOT NULL CHECK (entry_count >= 0),
  created_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL
);

CREATE FUNCTION usage_price_tables_guard_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
BEGIN
  SELECT max(version) INTO latest FROM usage_price_tables;
  IF NEW.version <> COALESCE(latest, 0) + 1 THEN
    RAISE EXCEPTION 'price table version must be %', COALESCE(latest, 0) + 1 USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER usage_price_tables_insert
  BEFORE INSERT ON usage_price_tables
  FOR EACH ROW EXECUTE FUNCTION usage_price_tables_guard_insert();

CREATE TABLE usage_prices (
  version                   integer NOT NULL REFERENCES usage_price_tables (version),
  provider                  text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  model                     text NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$'),
  effective_from            timestamptz NOT NULL,
  -- USD per million tokens.
  input_usd_per_mtok        numeric(20, 9) NOT NULL CHECK (input_usd_per_mtok >= 0),
  output_usd_per_mtok       numeric(20, 9) NOT NULL CHECK (output_usd_per_mtok >= 0),
  cache_read_usd_per_mtok   numeric(20, 9) NULL CHECK (cache_read_usd_per_mtok IS NULL OR cache_read_usd_per_mtok >= 0),
  cache_write_usd_per_mtok  numeric(20, 9) NULL CHECK (cache_write_usd_per_mtok IS NULL OR cache_write_usd_per_mtok >= 0),
  -- Where the number came from (provider price page, invoice, contract). Required.
  source                    text NOT NULL CHECK (length(source) BETWEEN 1 AND 500),
  PRIMARY KEY (version, provider, model, effective_from)
);

CREATE TRIGGER usage_price_tables_no_update_delete
  BEFORE UPDATE OR DELETE ON usage_price_tables
  FOR EACH ROW EXECUTE FUNCTION usage_reject_change();
CREATE TRIGGER usage_price_tables_no_truncate
  BEFORE TRUNCATE ON usage_price_tables
  FOR EACH STATEMENT EXECUTE FUNCTION usage_reject_change();
CREATE TRIGGER usage_prices_no_update_delete
  BEFORE UPDATE OR DELETE ON usage_prices
  FOR EACH ROW EXECUTE FUNCTION usage_reject_change();
CREATE TRIGGER usage_prices_no_truncate
  BEFORE TRUNCATE ON usage_prices
  FOR EACH STATEMENT EXECUTE FUNCTION usage_reject_change();

---------------------------------------------------------------------------------------------------
-- Budgets (definitions only; enforcement is p4-quotas). Soft-deleted, never removed.
---------------------------------------------------------------------------------------------------

CREATE TABLE usage_budgets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  metric       text NOT NULL CHECK (metric IN ('tokens', 'turns', 'wall_time_ms', 'cost_usd')),
  limit_value  numeric(24, 6) NOT NULL CHECK (limit_value > 0),
  scope_type   text NOT NULL CHECK (scope_type IN ('global', 'project', 'runtime', 'provider', 'worker')),
  scope_value  text NULL CHECK (scope_value IS NULL OR scope_value ~ '^[A-Za-z0-9_.:/@+-]{1,128}$'),
  time_window  text NOT NULL CHECK (time_window IN ('day', 'week', 'month')),
  enabled      boolean NOT NULL,
  version      integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by   uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL,
  updated_by   uuid NOT NULL REFERENCES users (id),
  updated_at   timestamptz NOT NULL,
  deleted_at   timestamptz NULL,
  deleted_by   uuid NULL REFERENCES users (id),
  CHECK ((scope_type = 'global') = (scope_value IS NULL)),
  CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);

CREATE INDEX usage_budgets_scope_idx ON usage_budgets (scope_type, scope_value) WHERE deleted_at IS NULL;

CREATE FUNCTION usage_budgets_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'usage_budgets rows cannot be removed (% rejected)', TG_OP USING ERRCODE = 'RA000';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'budget % is deleted and immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'budget % update must increment version by one', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF (NEW.id, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'budget % identity columns are immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER usage_budgets_guard
  BEFORE UPDATE OR DELETE ON usage_budgets
  FOR EACH ROW EXECUTE FUNCTION usage_budgets_guard();
CREATE TRIGGER usage_budgets_no_truncate
  BEFORE TRUNCATE ON usage_budgets
  FOR EACH STATEMENT EXECUTE FUNCTION usage_reject_change();

-- One row per threshold level crossed per (budget version, window): the insert that wins the unique key
-- also writes the `usage.budget.threshold` outbox row, so each crossing is announced exactly once.
CREATE TABLE usage_budget_alerts (
  budget_id      uuid NOT NULL REFERENCES usage_budgets (id),
  budget_version integer NOT NULL CHECK (budget_version >= 1),
  window_start   timestamptz NOT NULL,
  level          text NOT NULL CHECK (level IN ('warning', 'exceeded')),
  used           numeric(24, 9) NOT NULL,
  complete       boolean NOT NULL,
  raised_at      timestamptz NOT NULL,
  job_id         uuid NULL REFERENCES jobs (id),
  PRIMARY KEY (budget_id, budget_version, window_start, level)
);

CREATE TRIGGER usage_budget_alerts_no_update_delete
  BEFORE UPDATE OR DELETE ON usage_budget_alerts
  FOR EACH ROW EXECUTE FUNCTION usage_reject_change();
CREATE TRIGGER usage_budget_alerts_no_truncate
  BEFORE TRUNCATE ON usage_budget_alerts
  FOR EACH STATEMENT EXECUTE FUNCTION usage_reject_change();

REVOKE UPDATE, DELETE, TRUNCATE ON usage_records, usage_price_tables, usage_prices, usage_budget_alerts FROM PUBLIC;
