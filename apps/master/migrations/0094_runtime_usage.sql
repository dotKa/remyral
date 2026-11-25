-- p11-limit-visibility (docs/design/p11-limit-visibility.md): how much of the runtimes' usage limits is used before a
-- limit is hit — per worker × runtime × auth (the subscription login store or an API key): the latest windows (used %,
-- reset, kind), when and how they were read (a read-only probe or seen in a job / assistant turn), a bounded 24-hour
-- history for the sparklines, and the workspace setting of the "near the limit" notice. Additive only: older code
-- ignores the new tables.

CREATE TABLE runtime_usage_snapshots (
  worker_id    text NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  runtime      text NOT NULL CHECK (runtime ~ '^[a-z0-9_-]{1,32}$'),
  auth         text NOT NULL CHECK (auth IN ('subscription', 'api_key')),
  store        text NULL CHECK (store IS NULL OR store ~ '^[a-z][a-z0-9-]{0,31}$'),
  source       text NOT NULL CHECK (source IN ('probe', 'job', 'assistant')),
  plan         text NULL CHECK (plan IS NULL OR plan ~ '^[a-z0-9_.-]{1,32}$'),
  -- false: the runtime says plan limits do not apply to this login (an API key / a 3rd-party provider).
  available    boolean NOT NULL DEFAULT true,
  -- RuntimeUsageWindow[] (validated by the protocol schema before it is written; ≤ 12 entries).
  windows      jsonb NOT NULL CHECK (jsonb_typeof(windows) = 'array' AND jsonb_array_length(windows) <= 12),
  observed_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL,
  PRIMARY KEY (worker_id, runtime, auth)
);

-- One point per window when its value changed or 10 minutes passed; pruned after 24 hours (master tick).
CREATE TABLE runtime_usage_history (
  worker_id     text NOT NULL,
  runtime       text NOT NULL,
  auth          text NOT NULL,
  window_id     text NOT NULL CHECK (window_id ~ '^[a-z0-9][a-z0-9_.:-]{0,47}$'),
  at            timestamptz NOT NULL,
  used_percent  real NOT NULL CHECK (used_percent BETWEEN 0 AND 100),
  PRIMARY KEY (worker_id, runtime, auth, window_id, at),
  FOREIGN KEY (worker_id, runtime, auth)
    REFERENCES runtime_usage_snapshots (worker_id, runtime, auth) ON DELETE CASCADE
);
CREATE INDEX runtime_usage_history_at ON runtime_usage_history (at);

-- Workspace setting (singleton): the share of a window that counts as "near the limit" (badges, the composer hint and
-- the notice) and whether owners / admins get the notice (once per window and reset).
CREATE TABLE runtime_usage_settings (
  id              smallint PRIMARY KEY CHECK (id = 1),
  near_threshold  smallint NOT NULL DEFAULT 80 CHECK (near_threshold BETWEEN 50 AND 99),
  notify_near     boolean NOT NULL DEFAULT true,
  updated_by      uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL
);
INSERT INTO runtime_usage_settings (id, near_threshold, notify_near, updated_at) VALUES (1, 80, true, now());

-- Notification kind: appended to whatever the constraints allow now (other migrations of the same release may add
-- kinds too), so the list is read from the current definition instead of being repeated here.
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
    -- Either ARRAY['a'::text, …] (an IN list) or '{a,b,…}'::text[] (written by an earlier migration like this one,
    -- e.g. 0088 / 0092): both forms are read, and an empty result is refused instead of narrowing the constraint.
    IF def ~ '\{' THEN
      kinds := string_to_array(substring(def from '\{([^}]*)\}'), ',');
    ELSE
      SELECT array_agg(DISTINCT m[1]) INTO kinds FROM regexp_matches(def, '''([a-z0-9_.]+)''', 'g') AS m;
    END IF;
    IF coalesce(array_length(kinds, 1), 0) < 2 THEN
      RAISE EXCEPTION 'could not read the kinds of %', c;
    END IF;
    kinds := kinds || ARRAY['usage_limit.near'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, c, kinds);
  END LOOP;
END;
$$;
