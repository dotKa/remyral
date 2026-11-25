-- p20-scope-preview (owner 2026-10-31, complaints #7 / #10: "Makinede söylediğimi yap" held only for the user's own
-- turn — the plan / watch continuation of the SAME goal fell back to a card or an approval). The security policy's
-- `autonomy.goalGrants` ("Hedefe bağlı yetki"): what the user's OWN chat message ran directly is recorded as a
-- time-limited, revocable scope entry; a system-written continuation turn of that conversation (an approved autonomous
-- plan, a watch follow-up) inherits the user turn's direct run — and, for machine administration, `chatMachineAdmin` —
-- only for drafts inside that scope (same operation type, same machine / project). Everything else stays a card with
-- one reason. docs/design/p20-scope-preview.md.
--
--  * chat_goal_grants                      one row per directly-run draft of a user turn (its scope, until when)
--  * machine_admin_chat_grants.goal_grant_id  a machine administration job started under an inherited grant: its
--    elevated commands pass by policy only while that grant is not revoked (re-checked per command)
--
-- No foreign keys on chat rows (thread, draft): rows are written while chat rows may be locked (see 0200).
--
-- Additive. Rollback: an older master never reads the table or the column (continuations behave as before); to remove:
--   ALTER TABLE machine_admin_chat_grants DROP COLUMN goal_grant_id;
--   DROP TABLE chat_goal_grants;

CREATE TABLE chat_goal_grants (
  id            uuid PRIMARY KEY,
  thread_id     uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scope_class   text NOT NULL CHECK (scope_class ~ '^[a-z0-9_.:-]{1,80}$'),
  project       text NULL CHECK (project IS NULL OR project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  worker_id     text NULL CHECK (worker_id IS NULL OR char_length(worker_id) <= 128),
  machine_admin boolean NOT NULL,
  draft_id      uuid NULL,
  created_at    timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL CHECK (expires_at > created_at),
  revoked_at    timestamptz NULL
);
CREATE INDEX chat_goal_grants_thread ON chat_goal_grants (thread_id, user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE machine_admin_chat_grants ADD COLUMN goal_grant_id uuid NULL;
