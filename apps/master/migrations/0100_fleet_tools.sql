-- p13-fleet-tools (docs/design/p13-fleet-tools.md, ADR-0052): fleet-wide tool / runtime versions, bulk updates and
-- installs, admin-defined ("custom") tool recipes and the weekly update digest. Additive only: older code ignores the
-- new tables, the new remote-operation kinds and the new notification kind.

-- Latest version per catalog item, read by the master from the official source on a schedule (cache).
CREATE TABLE tool_version_feed (
  item        text PRIMARY KEY CHECK (item ~ '^[a-z][a-z0-9:-]{0,63}$'),
  source      text NOT NULL CHECK (length(source) <= 200),
  latest      text NULL CHECK (latest IS NULL OR length(latest) <= 64),
  ok          boolean NOT NULL,
  error       text NULL CHECK (error IS NULL OR length(error) <= 300),
  checked_at  timestamptz NOT NULL
);

-- Admin-defined tool recipes (validated by @remana/protocol CustomToolRecipe + customToolRecipeIssues).
CREATE TABLE custom_tool_recipes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{1,31}$'),
  recipe      jsonb NOT NULL CHECK (jsonb_typeof(recipe) = 'object' AND pg_column_size(recipe) <= 32768),
  created_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  archived_at timestamptz NULL
);
CREATE UNIQUE INDEX custom_tool_recipes_name ON custom_tool_recipes (name) WHERE archived_at IS NULL;

-- One bulk action (update / install / remove one item on many machines) and its per-machine targets.
CREATE TABLE fleet_tool_actions (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('tool.install', 'tool.remove', 'runtime.install', 'tool.elevated',
                                             'custom.install', 'custom.remove')),
  item         text NOT NULL CHECK (item ~ '^[a-z][a-z0-9:-]{0,63}$'),
  version      text NULL CHECK (version IS NULL OR length(version) <= 64),
  recipe_id    uuid NULL REFERENCES custom_tool_recipes (id) ON DELETE SET NULL,
  -- The custom recipe as it was when the action was created (what the targets install, even if it is edited later).
  recipe       jsonb NULL CHECK (recipe IS NULL OR jsonb_typeof(recipe) = 'object'),
  rollout      text NOT NULL CHECK (rollout IN ('all', 'canary-first')),
  approval_policy text NULL CHECK (approval_policy IS NULL OR approval_policy IN ('ask-all', 'allow-all')),
  state        text NOT NULL CHECK (state IN ('running', 'held', 'done', 'cancelled')),
  created_by   uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_ip   text NULL CHECK (created_ip IS NULL OR length(created_ip) <= 64),
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  finished_at  timestamptz NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX fleet_tool_actions_open ON fleet_tool_actions (created_at) WHERE state IN ('running', 'held');

CREATE TABLE fleet_tool_action_targets (
  action_id   uuid NOT NULL REFERENCES fleet_tool_actions (id) ON DELETE CASCADE,
  worker_id   text NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  phase       smallint NOT NULL CHECK (phase IN (1, 2)),
  state       text NOT NULL CHECK (state IN ('queued', 'held', 'sent', 'running', 'succeeded', 'failed', 'skipped',
                                              'expired', 'cancelled')),
  version     text NULL CHECK (version IS NULL OR length(version) <= 64),
  attempts    smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  reason      text NULL CHECK (reason IS NULL OR length(reason) <= 64),
  detail      text NULL CHECK (detail IS NULL OR length(detail) <= 500),
  op_id       uuid NULL,
  job_id      uuid NULL,
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (action_id, worker_id)
);
CREATE INDEX fleet_tool_action_targets_open ON fleet_tool_action_targets (worker_id)
  WHERE state IN ('queued', 'sent', 'running');

-- Workspace-wide settings (one row).
CREATE TABLE fleet_tool_settings (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  digest_enabled  boolean NOT NULL DEFAULT true,
  last_digest_at  timestamptz NULL,
  updated_by      uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at      timestamptz NULL
);
INSERT INTO fleet_tool_settings (id) VALUES (true);

-- Remote operation kinds: + tool.install.custom, tool.remove.custom (with custom-tools-v1).
ALTER TABLE worker_ops DROP CONSTRAINT worker_ops_kind_check;
ALTER TABLE worker_ops ADD CONSTRAINT worker_ops_kind_check
  CHECK (kind IN ('runtime.install', 'runtime.remove', 'runtime.restart', 'login.start', 'login.input',
                  'login.status', 'login.logout', 'ops.cancel', 'service.restart', 'logs.tail', 'diagnostics.run',
                  'sandbox.prepare', 'tools.detect', 'tool.install', 'tool.remove', 'machine.inspect',
                  'tool.install.custom', 'tool.remove.custom'));

-- Notification kind 'tools.updates': appended to whatever the constraints allow now (see 0095).
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
    kinds := kinds || ARRAY['tools.updates'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, c, kinds);
  END LOOP;
END;
$$;
