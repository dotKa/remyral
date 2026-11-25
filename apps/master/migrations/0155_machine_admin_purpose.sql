-- p17-worker-1-1-1 (docs/design/p17-worker-1-1-1.md): the agent's stated purpose of an elevated command of a
-- machine-admin job (MACHINE_ADMIN_REQUEST `purpose`, worker feature `machine-admin-purpose-v1`).
--
--  * machine_admin_commands.purpose: one line (at most 300 characters, redacted on the worker and again here), shown
--    in the command log and the approval labelled as the agent's unverified explanation. It is metadata: never part
--    of the operation digest or of the master's signature. NULL for older workers and calls without one.
--
-- Additive. Rollback: an older master ignores the column. To drop: ALTER TABLE machine_admin_commands DROP COLUMN
-- purpose.

ALTER TABLE machine_admin_commands
  ADD COLUMN purpose text NULL CHECK (purpose IS NULL OR char_length(purpose) BETWEEN 1 AND 300);
