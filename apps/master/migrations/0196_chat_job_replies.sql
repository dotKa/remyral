-- p19-job-replies (owner 2026-10-29: "cevap geldiğini ben nasıl bilicem?"): the agent's first answer to a message a
-- conversation sent to a running job (a confirmed job_message card) comes back to that conversation as a note, once.
--
--  * chat_flow_events keys gain `reply:<draft id>` (claimed once, also with several replicas).
--  * a partial index on the confirmed job_message cards (the tick's scan).
--
-- Additive. Rollback: an older master never writes the new keys and ignores the index; to remove:
--   DELETE FROM chat_flow_events WHERE key LIKE 'reply:%';
--   re-create chat_flow_events_key_check as in 0188.
--   DROP INDEX chat_drafts_job_message_cards_idx;

ALTER TABLE chat_flow_events DROP CONSTRAINT chat_flow_events_key_check;
ALTER TABLE chat_flow_events ADD CONSTRAINT chat_flow_events_key_check CHECK (
  key ~ '^(approval|result|question|decided|sched|reply):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR key ~ '^job:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,19}$'
  OR key ~ '^(gate|gatedone):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[a-z][a-z0-9_-]{0,47}(\.[a-z][a-z0-9_-]{0,31})?$'
);

CREATE INDEX chat_drafts_job_message_cards_idx ON chat_drafts (decided_at)
  WHERE state = 'confirmed' AND kind = 'job_message';
