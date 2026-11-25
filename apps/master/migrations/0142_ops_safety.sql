-- p16-ops-safety (docs/design/p16-ops-safety.md): credential expiry tracking and rotation stamps, the worker rollout
-- circuit breaker, the model cost brake. Additive only; the security policy's new sections (limits, costBrake, rollout)
-- live in the existing security_policy.document and need no column.
--
--  * secret_rotation_stamps: "rotated at" records the owner stamps after a documented rotation (console or the
--    `remana-master secrets:rotated` CLI). Dates only — never key material.
--  * secret_expiry_checks: the last result of the checks that call out (Cloudflare token verify, the served TLS
--    certificate of the public origin, the Coolify connection test), so the view does not call out on every read.
--  * secret_expiry_notices: one row per (item, due date, threshold) notified — 30 / 14 / 7 / 1 days and expired.
--  * vault_credentials.expires_at: an optional provider-side expiry date of a credential (metadata, set by an admin).
--  * release_rollout_holds: a rollout the breaker (or an admin) held, why, and how it was resolved.
--  * cost_brake_projects / cost_brake_lifts / cost_brake_events: per-project ceilings, an owner lifting the brake for
--    some hours, and each ceiling crossing (once per scope, window and level).
--  * notification kinds 'secret.expiring', 'release.rollout_paused', 'cost.brake'.
--
-- Rollback: an older master ignores all of it. To remove:
--   DELETE FROM notifications WHERE kind IN ('secret.expiring', 'release.rollout_paused', 'cost.brake');
--   DELETE FROM notification_preferences WHERE kind IN ('secret.expiring', 'release.rollout_paused', 'cost.brake');
--   DROP TABLE cost_brake_events, cost_brake_lifts, cost_brake_projects, release_rollout_holds,
--              secret_expiry_notices, secret_expiry_checks, secret_rotation_stamps;
--   ALTER TABLE vault_credentials DROP COLUMN expires_at;
-- Migration number 0142 (0141_runtime_updates is the one before it on main; renumber at merge if a parallel change
-- takes it).

CREATE TABLE secret_rotation_stamps (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- An item id of the expiry view (e.g. 'file:totp-key', 'cloudflare:token', 'backup:age-identity').
  item         text NOT NULL CHECK (item ~ '^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_.-]{1,64}$'),
  rotated_at   timestamptz NOT NULL,
  recorded_at  timestamptz NOT NULL,
  recorded_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  source       text NOT NULL CHECK (source IN ('console', 'cli', 'chat')),
  note         text NULL CHECK (note IS NULL OR char_length(note) <= 300)
);
CREATE INDEX secret_rotation_stamps_item ON secret_rotation_stamps (item, rotated_at DESC);

CREATE TABLE secret_expiry_checks (
  item         text PRIMARY KEY CHECK (item ~ '^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_.-]{1,64}$'),
  checked_at   timestamptz NOT NULL,
  ok           boolean NOT NULL,
  expires_at   timestamptz NULL,
  -- A short, secret-free outcome ("active", "expired", "connect failed: ECONNREFUSED" …).
  detail       text NULL CHECK (detail IS NULL OR char_length(detail) <= 300)
);

CREATE TABLE secret_expiry_notices (
  item         text NOT NULL CHECK (item ~ '^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_.-]{1,64}$'),
  due_at       timestamptz NOT NULL,
  -- Days before the due date (30, 14, 7, 1) or 0 = expired / overdue.
  threshold    integer NOT NULL CHECK (threshold IN (0, 1, 7, 14, 30)),
  notified_at  timestamptz NOT NULL,
  PRIMARY KEY (item, due_at, threshold)
);

ALTER TABLE vault_credentials ADD COLUMN expires_at timestamptz NULL;

CREATE TABLE release_rollout_holds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel          text NOT NULL CHECK (channel IN ('stable', 'canary')),
  version          text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 64),
  rollout_percent  integer NOT NULL CHECK (rollout_percent BETWEEN 0 AND 100),
  -- The version the channel pointed at before (the one-click rollback target); null: unknown.
  previous_version text NULL CHECK (previous_version IS NULL OR char_length(previous_version) BETWEEN 1 AND 64),
  -- update_failures | job_failures | manual
  reason           text NOT NULL CHECK (reason IN ('update_failures', 'job_failures', 'manual')),
  -- The breaker's numbers and the failing machines (ids, versions, reasons; no free text from workers).
  evidence         jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  tripped_at       timestamptz NOT NULL,
  tripped_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  resolved_at      timestamptz NULL,
  resolved_by      uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  resolution       text NULL CHECK (resolution IN ('resumed', 'rolled_back', 'superseded')),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);
-- At most one open hold per channel.
CREATE UNIQUE INDEX release_rollout_holds_open ON release_rollout_holds (channel) WHERE resolved_at IS NULL;
CREATE INDEX release_rollout_holds_recent ON release_rollout_holds (channel, version, tripped_at DESC);

CREATE TABLE cost_brake_projects (
  project      text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  daily_usd    numeric(14, 2) NULL CHECK (daily_usd IS NULL OR daily_usd > 0),
  monthly_usd  numeric(14, 2) NULL CHECK (monthly_usd IS NULL OR monthly_usd > 0),
  updated_at   timestamptz NOT NULL,
  updated_by   uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  CHECK (daily_usd IS NOT NULL OR monthly_usd IS NOT NULL)
);

CREATE TABLE cost_brake_lifts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'global' or a project id.
  scope       text NOT NULL CHECK (scope ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  expires_at  timestamptz NOT NULL,
  reason      text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  created_at  timestamptz NOT NULL,
  created_by  uuid NOT NULL REFERENCES users (id),
  revoked_at  timestamptz NULL,
  revoked_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX cost_brake_lifts_active ON cost_brake_lifts (scope, expires_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE cost_brake_events (
  scope         text NOT NULL CHECK (scope ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  time_window   text NOT NULL CHECK (time_window IN ('day', 'month')),
  window_start  timestamptz NOT NULL,
  -- warning: warnPercent reached; exceeded: 100 % reached.
  level         text NOT NULL CHECK (level IN ('warning', 'exceeded')),
  spent_usd     numeric(20, 6) NOT NULL,
  limit_usd     numeric(14, 2) NOT NULL,
  mode          text NOT NULL CHECK (mode IN ('warn', 'block')),
  raised_at     timestamptz NOT NULL,
  PRIMARY KEY (scope, time_window, window_start, level)
);

-- Notification kinds: appended to whatever the constraints allow now (see 0139).
DO $$
DECLARE
  t text;
  c text;
  def text;
  kinds text[];
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_preferences'] LOOP
    c := t || '_kind_check';
    SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
     WHERE conname = c AND conrelid = t::regclass;
    IF def IS NULL THEN
      RAISE EXCEPTION 'constraint % not found', c;
    END IF;
    IF def ~ '\{' THEN
      kinds := string_to_array(substring(def from '\{([^}]*)\}'), ',');
    ELSE
      SELECT array_agg(DISTINCT m[1]) INTO kinds FROM regexp_matches(def, '''([a-z0-9_.]+)''', 'g') AS m;
    END IF;
    IF coalesce(array_length(kinds, 1), 0) < 2 THEN
      RAISE EXCEPTION 'could not read the kinds of %', c;
    END IF;
    kinds := kinds || ARRAY['secret.expiring', 'release.rollout_paused', 'cost.brake'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, c, kinds);
  END LOOP;
END;
$$;
