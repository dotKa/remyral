-- p15-chat-zip (docs/design/p15-chat-zip.md): a .zip dropped into the console chat becomes an ordinary site upload
-- (unpacked in the browser, chunked upload, the master's checks — p10-site-upload) linked to the chat message that
-- carried it, so the assistant can publish it with publish_site_upload and list_site_uploads can say "attached in this
-- conversation". Additive only: two nullable links; deleting the conversation or the message only clears them.
--
-- Rollback: the older master selects named columns only and ignores these; drop them when wanted:
--   ALTER TABLE site_uploads DROP COLUMN chat_message_id, DROP COLUMN chat_thread_id;
-- Migration number 0135 (given in the brief); renumber at merge if needed.

ALTER TABLE site_uploads
  ADD COLUMN chat_thread_id  uuid NULL REFERENCES chat_threads (id) ON DELETE SET NULL,
  ADD COLUMN chat_message_id uuid NULL REFERENCES chat_messages (id) ON DELETE SET NULL;

CREATE INDEX site_uploads_chat_thread ON site_uploads (chat_thread_id) WHERE chat_thread_id IS NOT NULL;
