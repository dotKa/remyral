-- p17-panel-settings Part 4 (docs/design/p17-panel-settings.md §6): owners recover other users from the panel —
-- authenticator reset, password reset (a one-time password shown once), unlock — instead of `admin:reset` on the host.
--
--  * user_recovery_requests: a reset of another OWNER while a third active owner exists waits for that owner's
--    approval (the requester and the target cannot approve). Every other recovery applies at once and is only audited.
--    No secret is stored (the temporary password is generated when the request is applied and shown to the approver).
--  * notification kind 'account.recovery' (the affected user — also by e-mail whatever the preference — and the owners
--    who can approve a waiting request).
--
-- Additive. Rollback: an older master ignores the table. To remove:
--   DELETE FROM notifications WHERE kind = 'account.recovery';
--   DELETE FROM notification_preferences WHERE kind = 'account.recovery';
--   DROP TABLE user_recovery_requests;
CREATE TABLE user_recovery_requests (
  id            uuid PRIMARY KEY,
  target_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  action        text NOT NULL CHECK (action IN ('reset-mfa', 'reset-password', 'unlock')),
  reason        text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 300),
  state         text NOT NULL CHECK (state IN ('pending', 'applied', 'cancelled', 'expired')),
  requested_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  requested_at  timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL CHECK (expires_at > requested_at),
  decided_by    uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  decided_at    timestamptz NULL
);
-- One waiting request per target and action.
CREATE UNIQUE INDEX user_recovery_requests_one_pending ON user_recovery_requests (target_id, action)
  WHERE state = 'pending';

-- Notification kind 'account.recovery': appended to whatever the constraints allow now (see 0095, 0159, 0162).
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
    kinds := kinds || ARRAY['account.recovery'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, c, kinds);
  END LOOP;
END;
$$;
