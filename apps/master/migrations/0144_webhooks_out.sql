-- p16-webhooks-out (docs/design/p16-webhooks-out.md, ADR-0059): outgoing webhooks for external automation.
--
--  * webhook_subscriptions: target URL (https), event filter (types + optional project), the HMAC secret sealed with
--    an HKDF sub-key of the master key (never in clear; shown once), an optional previous secret for the rotation
--    overlap, custom headers (secret values sealed, never returned), active / paused / disabled (auto after N
--    consecutive failed attempts) and the failure counter.
--  * webhook_settings: the owner's exact internal origins a subscription may target although they are not public
--    (default empty: private / loopback / link-local / metadata addresses are always refused).
--  * webhook_consumer: the producer's cursor over audit_events (ids commit in order: the audit append is serialised
--    by an advisory lock held until commit, so a plain `id > floor` never skips a row).
--  * webhook_deliveries: the durable outbox of deliveries, one per (subscription, event), the frozen JSON body, the
--    retry schedule and a fenced claim (claim_token + claimed_until) so one master sends a delivery at a time.
--  * webhook_delivery_attempts: one row per attempt (status code, latency, a capped and redacted response excerpt).
--  * notification kind 'webhook.disabled'; chat draft kind 'webhook' (the assistant's draft_webhook card).
--
-- Rollback: an older master ignores all of it. To remove:
--   DELETE FROM notifications WHERE kind = 'webhook.disabled';
--   DELETE FROM notification_preferences WHERE kind = 'webhook.disabled';
--   DELETE FROM chat_drafts WHERE kind = 'webhook';
--   DROP TABLE webhook_delivery_attempts, webhook_deliveries, webhook_consumer, webhook_settings,
--              webhook_subscriptions;
-- Migration number 0144 (0143 is taken by p16-observability, 0142_ops_safety is on main; renumber at merge if a
-- parallel change takes it).

CREATE TABLE webhook_subscriptions (
  id                     uuid PRIMARY KEY,
  name                   text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  url                    text NOT NULL CHECK (char_length(url) BETWEEN 9 AND 2000 AND url ~ '^https://'),
  -- null: every project and the global events; a project: only that project's events.
  project                text NULL REFERENCES projects (id) ON DELETE CASCADE,
  event_types            text[] NOT NULL CHECK (cardinality(event_types) BETWEEN 1 AND 64),
  -- Opt-in redacted detail fields (failure reasons, approval summaries).
  include_details        boolean NOT NULL DEFAULT false,
  -- [{ "name": "...", "value": "..." } | { "name": "...", "sealed": "<base64>", "hint": "ab…yz" }]
  headers                jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(headers) = 'array'),
  secret_sealed          bytea NOT NULL,
  secret_hint            text NOT NULL CHECK (char_length(secret_hint) BETWEEN 4 AND 32),
  secret_created_at      timestamptz NOT NULL,
  -- The secret is shown once: at creation in the console, or once on request for a subscription the assistant made.
  secret_revealed_at     timestamptz NULL,
  previous_secret_sealed bytea NULL,
  previous_valid_until   timestamptz NULL,
  state                  text NOT NULL CHECK (state IN ('active', 'paused', 'disabled')),
  disabled_reason        text NULL CHECK (disabled_reason IS NULL OR disabled_reason IN ('consecutive_failures')),
  consecutive_failures   integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_success_at        timestamptz NULL,
  last_failure_at        timestamptz NULL,
  created_at             timestamptz NOT NULL,
  created_by             uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL,
  updated_by             uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  CHECK ((previous_secret_sealed IS NULL) = (previous_valid_until IS NULL)),
  CHECK ((state = 'disabled') = (disabled_reason IS NOT NULL))
);
CREATE INDEX webhook_subscriptions_active ON webhook_subscriptions (state) WHERE state = 'active';

CREATE TABLE webhook_settings (
  id               integer PRIMARY KEY CHECK (id = 1),
  -- Exact origins (`https://host:port`), set by an owner with a code (security.policy event).
  internal_origins text[] NOT NULL DEFAULT '{}' CHECK (cardinality(internal_origins) <= 32),
  updated_at       timestamptz NULL,
  updated_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL
);
INSERT INTO webhook_settings (id) VALUES (1);

CREATE TABLE webhook_consumer (
  name     text PRIMARY KEY,
  floor_id bigint NOT NULL CHECK (floor_id >= 0)
);
-- Start after the existing history: no burst of old events when the first subscription is made.
INSERT INTO webhook_consumer (name, floor_id) VALUES ('audit', COALESCE((SELECT max(id) FROM audit_events), 0));

CREATE TABLE webhook_deliveries (
  -- Sent as X-Remana-Delivery: the receiver's idempotency key (stable across retries and redeliveries).
  id               uuid PRIMARY KEY,
  seq              bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  subscription_id  uuid NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE CASCADE,
  -- Derived from the audit row and the type (the same event has the same id for every subscription).
  event_id         uuid NOT NULL,
  event_type       text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{0,63}$'),
  project          text NULL,
  audit_id         bigint NULL,
  -- The frozen JSON envelope (identical bytes on every attempt).
  body             text NOT NULL CHECK (octet_length(body) <= 65536),
  -- pending → succeeded | failed (all attempts used, or a test delivery's single attempt).
  status           text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  is_test          boolean NOT NULL DEFAULT false,
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL,
  claim_token      uuid NULL,
  claimed_until    timestamptz NULL,
  last_status_code integer NULL,
  -- A fixed code (timeout, dns, address_refused, tls, connect, network, http_503 …), never a message.
  last_error       text NULL CHECK (last_error IS NULL OR last_error ~ '^[a-z][a-z0-9_]{0,63}$'),
  last_latency_ms  integer NULL,
  last_attempt_at  timestamptz NULL,
  created_at       timestamptz NOT NULL,
  finished_at      timestamptz NULL,
  UNIQUE (subscription_id, event_id),
  CHECK ((status = 'pending') = (finished_at IS NULL)),
  CHECK ((claim_token IS NULL) = (claimed_until IS NULL))
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at, seq) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_subscription ON webhook_deliveries (subscription_id, seq DESC);
CREATE INDEX webhook_deliveries_finished ON webhook_deliveries (finished_at) WHERE finished_at IS NOT NULL;

CREATE TABLE webhook_delivery_attempts (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id      uuid NOT NULL REFERENCES webhook_deliveries (id) ON DELETE CASCADE,
  attempt          integer NOT NULL CHECK (attempt >= 1),
  started_at       timestamptz NOT NULL,
  latency_ms       integer NULL CHECK (latency_ms IS NULL OR latency_ms >= 0),
  status_code      integer NULL,
  error            text NULL CHECK (error IS NULL OR error ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- At most 1 KiB of the response body, control characters removed and secret patterns redacted.
  response_excerpt text NULL CHECK (response_excerpt IS NULL OR char_length(response_excerpt) <= 1024)
);
CREATE INDEX webhook_delivery_attempts_delivery ON webhook_delivery_attempts (delivery_id, attempt);

CREATE FUNCTION pg_temp.widen_check_0144(t text, c text, col text, extra text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  def text;
  vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = c AND conrelid = t::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint % not found', c;
  END IF;
  -- Either `col = ANY ('{a,b}'::text[])` (written by an earlier widening) or `col IN ('a', 'b')`.
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

SELECT pg_temp.widen_check_0144('notifications', 'notifications_kind_check', 'kind', ARRAY['webhook.disabled']);
SELECT pg_temp.widen_check_0144('notification_preferences', 'notification_preferences_kind_check', 'kind',
                                ARRAY['webhook.disabled']);
SELECT pg_temp.widen_check_0144('chat_drafts', 'chat_drafts_kind_check', 'kind', ARRAY['webhook']);
