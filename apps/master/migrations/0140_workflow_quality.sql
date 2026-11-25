-- p16-workflow-quality (docs/design/p16-workflow-quality.md): no cards for invalid drafts, schedules in a time zone.
-- Additive only.
--
--  * chat_drafts.state + 'invalid': a draft the master's validation refused. It is kept (hidden) so the assistant's
--    repair loop and the audit can find it, but it is never listed in a thread, never confirmable and never expires
--    into a card. The "Taslak geçersiz" line of a turn that gave up is built from these rows.
--  * automations.time_zone: the IANA zone a cron / one-time schedule is read in. Every existing row is UTC (what the
--    scheduler has always used), so nothing that is scheduled now moves.
--
-- Rollback: an older master never reads either; it would list invalid drafts as failed-looking cards, so remove them
-- first and narrow the constraint by hand, then drop the column (schedules in other zones would then run in UTC):
--   DELETE FROM chat_drafts WHERE state = 'invalid';
--   ALTER TABLE automations DROP COLUMN time_zone;
-- Migration number 0140 (main had 0139 at branch time); renumber at merge if a parallel change took it.

CREATE FUNCTION pg_temp.widen_check_0140(t text, c text, col text, extra text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  def text;
  vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = c AND conrelid = t::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint % not found', c;
  END IF;
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

SELECT pg_temp.widen_check_0140('chat_drafts', 'chat_drafts_state_check', 'state', ARRAY['invalid']);

-- The invalid attempts of one turn (the give-up line and the repair loop read them per turn).
CREATE INDEX chat_drafts_invalid_turn ON chat_drafts (turn_id) WHERE state = 'invalid';

ALTER TABLE automations
  ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC' CHECK (time_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$');
