-- p18-outputs-delivery (docs/design/p18-outputs-delivery.md §4): a conversation hears how every job it started ended.
-- Owner 2026-10-28: "chatten bir iş başladığında ve hata verdiğinde o chatten dönüş olmalı".
--
--  * chat_flow_events keys gain `job:<job id>:<transition id>` — one result card per job outcome (the terminal
--    transition), claimed once also with several replicas (ON CONFLICT DO NOTHING, as for 0177's keys). A job that
--    runs again (resume, reconciliation) and ends again has a new transition, so a new card.
--  * an index on the confirmed cards that start jobs (the tick's scan, like 0177's run-card index).
--
-- Additive. Rollback: an older master never writes the new keys and ignores the index; to remove:
--   DELETE FROM chat_flow_events WHERE key LIKE 'job:%';
--   ALTER TABLE chat_flow_events DROP CONSTRAINT chat_flow_events_key_check;
--   ALTER TABLE chat_flow_events ADD CONSTRAINT chat_flow_events_key_check
--     CHECK (key ~ '^(approval|result|question):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
--   DROP INDEX chat_drafts_job_cards_idx;

ALTER TABLE chat_flow_events DROP CONSTRAINT chat_flow_events_key_check;
ALTER TABLE chat_flow_events ADD CONSTRAINT chat_flow_events_key_check CHECK (
  key ~ '^(approval|result|question):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR key ~ '^job:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,19}$'
);

CREATE INDEX chat_drafts_job_cards_idx ON chat_drafts (decided_at)
  WHERE state = 'confirmed' AND kind IN ('job', 'machine_task', 'tool_install', 'automation', 'job_action');
