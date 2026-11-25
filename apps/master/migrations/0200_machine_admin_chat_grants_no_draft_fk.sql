-- p19-chat-machine-admin fix: a grant row is written while the chat card that started the job is being confirmed —
-- DraftExecutor.confirm holds `chat_drafts … FOR UPDATE` in its transaction and MachineAdminService.createTask
-- inserts the grant on another connection. The foreign key check of `draft_id` needs FOR KEY SHARE on that very
-- draft row, so the insert waited for a transaction that waited for the insert (the confirmation never returned).
-- `draft_id` / `thread_id` are audit references only: they lose their foreign keys (no lock on the chat rows).
--
-- Rollback: nothing reads the constraints; to restore them (after removing rows whose draft / thread is gone):
--   ALTER TABLE machine_admin_chat_grants ADD FOREIGN KEY (draft_id) REFERENCES chat_drafts (id) ON DELETE SET NULL;
--   ALTER TABLE machine_admin_chat_grants ADD FOREIGN KEY (thread_id) REFERENCES chat_threads (id) ON DELETE SET NULL;

ALTER TABLE machine_admin_chat_grants DROP CONSTRAINT IF EXISTS machine_admin_chat_grants_draft_id_fkey;
ALTER TABLE machine_admin_chat_grants DROP CONSTRAINT IF EXISTS machine_admin_chat_grants_thread_id_fkey;
