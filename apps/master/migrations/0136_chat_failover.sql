-- p15-chat-failover (docs/design/p15-chat-failover.md): backup machines for the chat assistant. Additive only.
--
--  * chat_settings.backup_worker_ids: the ordered backup assistant workers after the primary (0–6; ids of approved
--    workers, checked on save; a removed worker is skipped when read).
--  * chat_failover: one row — automatic failover on / off, a temporary pin, and the machine that answers now (the
--    routing state every replica shares; changed with a compare-and-set).
--  * chat_failover_events: switches and manual changes (the "recent switches" list; the audit log keeps them too).
--  * chat_turns.rerun_of: a turn that re-runs a turn lost with its machine (once per message, across replicas).
--  * notification kind 'chat.failover' (one per switch to a backup and per return).
--
-- Rollback: an older master ignores all of it (the chat uses the primary only). To remove:
--   DELETE FROM notifications WHERE kind = 'chat.failover';
--   DELETE FROM notification_preferences WHERE kind = 'chat.failover';
--   DROP TABLE chat_failover_events, chat_failover;
--   ALTER TABLE chat_settings DROP COLUMN backup_worker_ids;
--   ALTER TABLE chat_turns DROP COLUMN rerun_of;
-- Migration number 0136 (0135 is taken by a parallel change); renumber at merge if needed.

ALTER TABLE chat_settings
  ADD COLUMN backup_worker_ids text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(backup_worker_ids) <= 6);

CREATE TABLE chat_failover (
  id                smallint PRIMARY KEY CHECK (id = 1),
  auto              boolean NOT NULL DEFAULT true,
  pin_worker_id     text NULL CHECK (pin_worker_id IS NULL OR length(pin_worker_id) <= 128),
  pin_until         timestamptz NULL,
  pinned_by         uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  active_worker_id  text NULL CHECK (active_worker_id IS NULL OR length(active_worker_id) <= 128),
  active_reason     text NULL CHECK (active_reason IS NULL OR active_reason ~ '^[a-z_]{1,32}$'),
  active_since      timestamptz NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((pin_worker_id IS NULL) = (pin_until IS NULL))
);
INSERT INTO chat_failover (id) VALUES (1);

CREATE TABLE chat_failover_events (
  id              bigserial PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('failover', 'return', 'rerun', 'pin', 'unpin', 'force_primary',
                                                'auto_off', 'auto_on')),
  from_worker_id  text NULL CHECK (from_worker_id IS NULL OR length(from_worker_id) <= 128),
  to_worker_id    text NULL CHECK (to_worker_id IS NULL OR length(to_worker_id) <= 128),
  reason          text NULL CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,32}$'),
  actor_id        uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  at              timestamptz NOT NULL
);
CREATE INDEX chat_failover_events_at ON chat_failover_events (at DESC, id DESC);

ALTER TABLE chat_turns ADD COLUMN rerun_of uuid NULL;

-- Notification kind 'chat.failover': appended to whatever the constraints allow now (see 0095 / 0126).
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
    kinds := kinds || ARRAY['chat.failover'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, c, kinds);
  END LOOP;
END;
$$;
