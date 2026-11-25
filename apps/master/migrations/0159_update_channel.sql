-- p17-update-channel (ADR-0065, docs/design/p17-update-channel.md): the master pulls the vendor's signed worker release
-- feed and imports releases like a manual upload; the owner's policy decides which ones roll out by themselves (canary
-- first); a separately signed version catalog of runtime / tool versions is stored and sent to capable workers.
--
--  * update_channel_settings: one row — policy (patch_auto | manual | auto) and the canary soak time.
--  * update_channel_feed: one row — the last verified worker feed (exact bytes + signature), where it came from, the
--    last check and its problem.
--  * update_channel_releases: per feed release — bump against the stable channel, state, last import failure.
--  * update_channel_rollouts: a canary-first rollout (stage, the canary machines it targeted, outcome).
--  * version_catalogs: accepted catalogs (exact bytes + signature; sequence monotonic).
--  * worker_version_catalogs: what each worker reported (sequence, last delivery outcome).
--  * owner_upgrades: the owner's upgrade of one runtime / tool to an exact upstream version (canary first, then the
--    fleet; the runtime policy versions it wrote, for the one-click rollback).
--  * notification kind 'release.update' (a release waits for "Güncelle" / a canary failed; owners and admins).
--
-- Additive. Rollback: an older master ignores the tables (system-set update targets it may leave behind are ordinary
-- targets an admin can clear). To remove:
--   DELETE FROM notifications WHERE kind = 'release.update';
--   DELETE FROM notification_preferences WHERE kind = 'release.update';
--   DROP TABLE owner_upgrades, worker_version_catalogs, version_catalogs, update_channel_rollouts, update_channel_releases,
--              update_channel_feed, update_channel_settings;
-- Migration number 0159 (0158_disk_hygiene is the one before it on main; renumber at merge if a parallel change takes it).

CREATE TABLE update_channel_settings (
  id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  policy        text NOT NULL DEFAULT 'patch_auto' CHECK (policy IN ('patch_auto', 'manual', 'auto')),
  soak_minutes  integer NOT NULL DEFAULT 30 CHECK (soak_minutes BETWEEN 0 AND 10080),
  updated_at    timestamptz NULL,
  updated_by    uuid NULL REFERENCES users (id) ON DELETE SET NULL
);
INSERT INTO update_channel_settings (id) VALUES (1);

CREATE TABLE update_channel_feed (
  id           smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  feed         bytea NULL CHECK (feed IS NULL OR length(feed) <= 1048576),
  signature    jsonb NULL,
  key_id       text NULL CHECK (key_id IS NULL OR key_id ~ '^[a-f0-9]{16}$'),
  source       text NULL CHECK (source IS NULL OR source IN ('url', 'file')),
  generated_at timestamptz NULL,
  checked_at   timestamptz NULL,
  error        text NULL CHECK (error IS NULL OR error ~ '^[a-z0-9_]{1,64}$')
);
INSERT INTO update_channel_feed (id) VALUES (1);

CREATE TABLE update_channel_releases (
  version       text PRIMARY KEY CHECK (
                  length(version) <= 64
                  AND version ~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(-[0-9A-Za-z.-]+)?$'),
  bump          text NOT NULL CHECK (bump IN ('first', 'same', 'older', 'patch', 'minor', 'major', 'prerelease')),
  -- available → imported → awaiting_approval | rolling_out → done; import_failed (retried after a back-off),
  -- canary_failed, skipped (a newer release started first).
  state         text NOT NULL CHECK (state IN ('available', 'imported', 'awaiting_approval', 'rolling_out', 'done',
                  'import_failed', 'canary_failed', 'skipped')),
  error         text NULL CHECK (error IS NULL OR error ~ '^[a-z0-9_]{1,64}$'),
  attempted_at  timestamptz NULL,
  imported_at   timestamptz NULL,
  first_seen_at timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);

CREATE TABLE update_channel_rollouts (
  id              uuid PRIMARY KEY,
  version         text NOT NULL REFERENCES worker_releases (version),
  stage           text NOT NULL CHECK (stage IN ('canary', 'fleet', 'done', 'canary_failed', 'superseded')),
  canary_workers  jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(canary_workers) = 'array'),
  -- 'auto' (policy) or the user who pressed "Güncelle".
  started_by      uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  trigger         text NOT NULL CHECK (trigger IN ('policy', 'owner')),
  started_at      timestamptz NOT NULL,
  stage_at        timestamptz NOT NULL,
  canary_passed_at timestamptz NULL,
  finished_at     timestamptz NULL,
  reason          text NULL CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,64}$')
);
-- At most one rollout in progress.
CREATE UNIQUE INDEX update_channel_rollouts_open ON update_channel_rollouts ((true))
  WHERE stage IN ('canary', 'fleet');
CREATE INDEX update_channel_rollouts_version ON update_channel_rollouts (version, started_at DESC);

CREATE TABLE version_catalogs (
  sequence      integer PRIMARY KEY CHECK (sequence >= 1),
  catalog       bytea NOT NULL CHECK (length(catalog) BETWEEN 1 AND 393216),
  signature     jsonb NOT NULL CHECK (jsonb_typeof(signature) = 'object'),
  key_id        text NOT NULL CHECK (key_id ~ '^[a-f0-9]{16}$'),
  sha256        text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  generated_at  timestamptz NOT NULL,
  received_at   timestamptz NOT NULL,
  source        text NOT NULL CHECK (source IN ('url', 'file'))
);

CREATE TABLE worker_version_catalogs (
  worker_id     text PRIMARY KEY REFERENCES workers (id) ON DELETE CASCADE,
  enabled       boolean NOT NULL,
  keys          integer NOT NULL CHECK (keys BETWEEN 0 AND 4),
  sequence      integer NOT NULL CHECK (sequence >= 0),
  key_id        text NULL CHECK (key_id IS NULL OR key_id ~ '^[a-f0-9]{16}$'),
  skipped       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(skipped) = 'array'),
  -- The last delivery: sequence and outcome (accepted | already_current | refused) with the refusal code.
  last_sequence integer NULL,
  last_outcome  text NULL CHECK (last_outcome IS NULL OR last_outcome IN ('accepted', 'already_current', 'refused')),
  last_reason   text NULL CHECK (last_reason IS NULL OR last_reason ~ '^[a-z0-9_]{1,64}$'),
  sent_sequence integer NULL,
  sent_at       timestamptz NULL,
  reported_at   timestamptz NOT NULL
);

CREATE TABLE owner_upgrades (
  id              uuid PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('runtime', 'tool')),
  item            text NOT NULL CHECK (item ~ '^[a-z][a-z0-9-]{1,31}$'),
  version         text NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
  -- The fleet's version before (the rollback target).
  from_version    text NULL CHECK (from_version IS NULL OR length(from_version) <= 64),
  -- The resolved source: npm package + integrity, or per platform the published asset checksums.
  source          jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  action_id       uuid NULL REFERENCES fleet_tool_actions (id) ON DELETE SET NULL,
  rollback_action_id uuid NULL REFERENCES fleet_tool_actions (id) ON DELETE SET NULL,
  -- canary → done | rolled_back | cancelled
  state           text NOT NULL CHECK (state IN ('canary', 'done', 'rolled_back', 'cancelled')),
  -- The canary's verification outcome when confirmed: passed | failed | none.
  canary_result   text NULL CHECK (canary_result IS NULL OR canary_result IN ('passed', 'failed', 'none')),
  -- policy name → { before: active version before, after: the version written }.
  policies        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(policies) = 'object'),
  created_by      uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);
CREATE INDEX owner_upgrades_created ON owner_upgrades (created_at DESC);

-- Notification kind 'release.update': appended to whatever the constraints allow now (see 0095).
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
    kinds := kinds || ARRAY['release.update'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, c, kinds);
  END LOOP;
END;
$$;
