-- p17-worker-managed Part 1 (docs/design/p17-worker-managed.md §1): a machine update that its updater rolled back
-- (e.g. DESKTOP-N946I4R 1.1.4 → 1.1.3, the new version did not report healthy) or that failed is a notification for
-- owners and admins, once per attempt — not only a line in the attempt history.
--
--  * notification kind 'worker.update_failed'.
--
-- Additive. Rollback: an older master never writes the kind; to remove it:
--   DELETE FROM notifications WHERE kind = 'worker.update_failed';
--   DELETE FROM notification_preferences WHERE kind = 'worker.update_failed';
--   and re-create both *_kind_check constraints without it (same block as below).

-- Notification kinds: appended to whatever the constraints allow now (see 0139 / 0142).
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
    kinds := kinds || ARRAY['worker.update_failed'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, c, kinds);
  END LOOP;
END;
$$;
