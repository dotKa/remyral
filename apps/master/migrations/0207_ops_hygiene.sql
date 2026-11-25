-- p22-ops-hygiene (docs/design/p22-ops-hygiene.md): bookkeeping for two loops that never ended or flapped.
--
--  * ops_actions.poll_errors / poll_not_found / next_poll_at  the deploy status poller's backoff (transient provider
--    errors: exponential up to 5 min) and its count of consecutive "not found" answers for the action's deployment
--    (3 in a row: the action fails — the provider no longer knows it). Reset by every successful poll.
--  * alert_states.clear_since  when a firing alert's condition was first seen clear (resolve hysteresis: the alert is
--    resolved only after it stayed clear for 15 min; NULL while the condition holds).
--
-- Additive. Rollback: an older master never reads the columns (it polls every 15 s and resolves at once, as before);
-- to remove:
--   ALTER TABLE ops_actions DROP COLUMN poll_errors, DROP COLUMN poll_not_found, DROP COLUMN next_poll_at;
--   ALTER TABLE alert_states DROP COLUMN clear_since;

ALTER TABLE ops_actions
  ADD COLUMN poll_errors    integer NOT NULL DEFAULT 0 CHECK (poll_errors >= 0),
  ADD COLUMN poll_not_found integer NOT NULL DEFAULT 0 CHECK (poll_not_found >= 0),
  ADD COLUMN next_poll_at   timestamptz NULL;

ALTER TABLE alert_states ADD COLUMN clear_since timestamptz NULL;
