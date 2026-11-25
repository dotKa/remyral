-- p17-panel-settings Part 0 (ADR-0063 amendment 2026-10-26, "host time lock"; docs/design/p17-panel-settings.md §2):
-- a backup request that ADDS an encryption recipient or CHANGES the off-site target waits 72 h on the remyral-ctl host,
-- counted from the time the host first saw it. The master only reflects what the host reports in its heartbeat.
--
--  * host_action_requests.state gains 'scheduled' (the host accepted the request; a part of it waits for the lock).
--  * backup_change_notices: one row per waiting change the master saw in the heartbeat (keyed by the change and the
--    host's own first-seen time), so every owner is told once when it appears and once 24 h before it takes effect.
--    Nothing here can shorten the wait: the host keeps its own time in root-owned state.
--  * notification kind 'backup.change_pending' (owners; also sent by e-mail to every owner with an address,
--    regardless of the per-kind preference).
--
-- Additive. Rollback: an older master ignores the table; rows with state 'scheduled' are final. To remove:
--   DELETE FROM notifications WHERE kind = 'backup.change_pending';
--   DELETE FROM notification_preferences WHERE kind = 'backup.change_pending';
--   DROP TABLE backup_change_notices;  (and restore the state constraint without 'scheduled' after updating its rows)

ALTER TABLE host_action_requests DROP CONSTRAINT host_action_requests_state_check;
ALTER TABLE host_action_requests ADD CONSTRAINT host_action_requests_state_check CHECK (
  state IN ('pending', 'applying', 'applied', 'scheduled', 'rolled_back', 'held', 'failed', 'refused', 'expired',
            'cancelled')
);

CREATE TABLE backup_change_notices (
  change        text NOT NULL CHECK (change IN ('recipients', 'offsite')),
  -- The host's first-seen time of the change (its own clock; the master never sets it).
  since         timestamptz NOT NULL,
  request_id    text NOT NULL CHECK (char_length(request_id) <= 64),
  until         timestamptz NOT NULL CHECK (until > since),
  -- recipients: the added age public keys; offsite: the target without credentials.
  added         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(added) = 'array'),
  target        text NOT NULL DEFAULT '' CHECK (char_length(target) <= 400),
  seen_at       timestamptz NOT NULL,
  reminded_at   timestamptz NULL,
  -- applied | cancelled | superseded | refused | gone (left the heartbeat without an outcome the master saw).
  resolved      text NULL CHECK (resolved IS NULL OR resolved ~ '^[a-z]{1,20}$'),
  resolved_at   timestamptz NULL,
  PRIMARY KEY (change, since)
);
CREATE INDEX backup_change_notices_open ON backup_change_notices (until) WHERE resolved IS NULL;

-- Notification kind 'backup.change_pending': appended to whatever the constraints allow now (see 0095, 0159).
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
    kinds := kinds || ARRAY['backup.change_pending'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, c, kinds);
  END LOOP;
END;
$$;
