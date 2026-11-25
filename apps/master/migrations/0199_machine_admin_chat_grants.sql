-- p19-chat-machine-admin (owner 2026-10-30: "ben makinede şunu yap dediğimde onu yapmalı"): the security policy's
-- `autonomy.chatMachineAdmin` ("Makinede söylediğimi yap"). A machine administration job the user's OWN chat message
-- started while the switch was on gets a grant row: its elevated (root / Administrator) commands pass by policy
-- instead of waiting for a human approval — re-checked per command (the switch still on, the user still an active
-- owner / admin) and audited as `machine.admin.command.grant` with `approvedBy: policy`.
--
--  * machine_admin_chat_grants  one row per such job (who asked, from which card and conversation).
--
-- Additive. Rollback: an older master never reads the table (every command asks a human again); to remove:
--   DROP TABLE machine_admin_chat_grants;

CREATE TABLE machine_admin_chat_grants (
  job_id     uuid PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  draft_id   uuid NULL REFERENCES chat_drafts (id) ON DELETE SET NULL,
  thread_id  uuid NULL REFERENCES chat_threads (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX machine_admin_chat_grants_user ON machine_admin_chat_grants (user_id, created_at DESC);
