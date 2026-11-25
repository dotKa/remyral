-- p8-capacity-auto (docs/design/p8-capacity-auto.md): per-machine capacity mode (manual | suggest | auto) with admin
-- bounds, the controller's state, and the history of every capacity change (chart on the machine page).

-- One row per machine that left the default (manual, no row). `slots` is the master's lease cap in auto mode (the
-- worker's panel configuration then says `max_slots`; placement uses LEAST(reported, slots)).
CREATE TABLE worker_capacity (
  worker_id         text PRIMARY KEY REFERENCES workers (id) ON DELETE CASCADE,
  mode              text NOT NULL CHECK (mode IN ('manual', 'suggest', 'auto')),
  min_slots         integer NOT NULL CHECK (min_slots BETWEEN 1 AND 64),
  max_slots         integer NOT NULL CHECK (max_slots BETWEEN 1 AND 64),
  slots             integer NULL CHECK (slots BETWEEN 0 AND 64),
  -- Controller state (window of estimates, streak and cool-down timestamps); numbers only.
  state             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(state) = 'object'),
  -- The last evaluation {action, from, to, upper, estimate, suggestion, reasons[{code,text}], metrics, at}.
  last_decision     jsonb NULL CHECK (last_decision IS NULL OR jsonb_typeof(last_decision) = 'object'),
  last_evaluated_at timestamptz NULL,
  updated_at        timestamptz NOT NULL,
  updated_by        text NULL,
  CHECK (min_slots <= max_slots),
  CHECK (mode <> 'auto' OR slots IS NOT NULL)
);

-- Every change: controller steps (raise / lower / clamp), suggestions, mode and bound changes, manual overrides.
-- Pruned to the newest 500 per machine.
CREATE TABLE worker_capacity_events (
  id          bigserial PRIMARY KEY,
  worker_id   text NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  at          timestamptz NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('raise', 'lower', 'clamp', 'suggest', 'mode', 'bounds', 'override')),
  mode        text NOT NULL CHECK (mode IN ('manual', 'suggest', 'auto')),
  from_slots  integer NULL CHECK (from_slots BETWEEN 0 AND 64),
  to_slots    integer NULL CHECK (to_slots BETWEEN 0 AND 64),
  reasons     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasons) = 'array'),
  metrics     jsonb NULL CHECK (metrics IS NULL OR jsonb_typeof(metrics) = 'object'),
  actor_type  text NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_id    text NULL
);
CREATE INDEX worker_capacity_events_worker_idx ON worker_capacity_events (worker_id, at DESC, id DESC);

-- The panel configuration generation the capacity mode writes (entering / leaving auto, a new max bound).
ALTER TABLE worker_config_versions DROP CONSTRAINT worker_config_versions_cause_check;
ALTER TABLE worker_config_versions ADD CONSTRAINT worker_config_versions_cause_check
  CHECK (cause IN ('edit', 'bulk', 'project', 'rollback', 'adopt', 'repository', 'catalog', 'workspace',
                   'unconfined', 'login', 'machine_admin', 'skills_key', 'runtime_removed', 'capacity'));
