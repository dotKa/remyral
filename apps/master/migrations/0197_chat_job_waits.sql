-- p19-job-waits (owner 2026-10-30: "iş bitince haber vermiyor"): a job started from a conversation that stops for a
-- person (a merge approval after its work is done, a gated command) says so in that conversation, once per request.
--
--  * chat_flow_events keys gain `jobwait:<approval request id>` (claimed once, also with several replicas).
--
-- Additive. Rollback: an older master never writes the new keys; to remove:
--   DELETE FROM chat_flow_events WHERE key LIKE 'jobwait:%';
--   re-create chat_flow_events_key_check as in 0196.

ALTER TABLE chat_flow_events DROP CONSTRAINT chat_flow_events_key_check;
ALTER TABLE chat_flow_events ADD CONSTRAINT chat_flow_events_key_check CHECK (
  key ~ '^(approval|result|question|decided|sched|reply|jobwait):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR key ~ '^job:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,19}$'
  OR key ~ '^(gate|gatedone):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[a-z][a-z0-9_-]{0,47}(\.[a-z][a-z0-9_-]{0,31})?$'
);
