-- p17-chat-reconnect (docs/design/p17-chat-reconnect.md): the last connection drops of each worker, as the worker
-- reported them in its next HELLO (`lastDisconnect`: when, cause — pong timeout / socket error / closed / worker closed /
-- upgrade refused —, close code, detail, how long the connection had been up, the pong wait and the worker's worst
-- event-loop delay of the minute before). Newest first, at most 10 (the master trims on every write). Shown on the
-- machine page ("Son bağlantı kopmaları").
--
-- Additive. Rollback: an older master ignores the column; to remove: ALTER TABLE workers DROP COLUMN disconnects;

ALTER TABLE workers
  ADD COLUMN disconnects jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(disconnects) = 'array');
