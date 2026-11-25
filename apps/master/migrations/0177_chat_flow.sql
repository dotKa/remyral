-- p17-chat-flow (docs/design/p17-chat-flow.md): what the website's sample screens show in the chat, made real —
-- a workflow's approval step as a card in the conversation that started / watches / created it (and in "Senden
-- bekleyen" and as a notification), a workflow result card, and a job agent's questions in the conversation that
-- started the job.
--
--  * chat_flow_events: one row per announced occurrence (`approval:<node run id>`, `result:<run id>`,
--    `question:<question id>`) — the tick posts each one exactly once, also with several replicas (the insert is the
--    claim; ON CONFLICT DO NOTHING). No content, only the key and when.
--  * an index on waiting approvals of engine-2 node runs (the tick and "Senden bekleyen" scan them) and one on the
--    confirmed run cards of conversations (the result scan).
--  * notification kind 'workflow.approval' (the users who may decide the step).
--
-- Additive. Rollback: an older master ignores the table and the indexes and never writes the kind; to remove:
--   DROP TABLE chat_flow_events;
--   DROP INDEX workflow_node_runs_approval_wait_idx; DROP INDEX chat_drafts_run_cards_idx;
--   DELETE FROM notifications WHERE kind = 'workflow.approval';
--   DELETE FROM notification_preferences WHERE kind = 'workflow.approval';
--   and re-create both *_kind_check constraints without it (same block as below).

CREATE TABLE chat_flow_events (
  key         text PRIMARY KEY CHECK (key ~ '^(approval|result|question):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  created_at  timestamptz NOT NULL
);
CREATE INDEX chat_flow_events_created_idx ON chat_flow_events (created_at);

CREATE INDEX workflow_node_runs_approval_wait_idx ON workflow_node_runs (created_at) WHERE wait_kind = 'approval';

CREATE INDEX chat_drafts_run_cards_idx ON chat_drafts (decided_at)
  WHERE kind = 'workflow_run' AND state = 'confirmed';

-- Notification kinds: appended to whatever the constraints allow now (see 0139 / 0142 / 0166).
DO $$
DECLARE
  t text;
  c text;
  def text;
  kinds text[];
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_preferences'] LOOP
    c := t || '_kind_check';
    SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
     WHERE conname = c AND conrelid = t::regclass;
    IF def IS NULL THEN
      RAISE EXCEPTION 'constraint % not found', c;
    END IF;
    IF def ~ '\{' THEN
      kinds := string_to_array(substring(def from '\{([^}]*)\}'), ',');
    ELSE
      SELECT array_agg(DISTINCT m[1]) INTO kinds FROM regexp_matches(def, '''([a-z0-9_.]+)''', 'g') AS m;
    END IF;
    IF coalesce(array_length(kinds, 1), 0) < 2 THEN
      RAISE EXCEPTION 'could not read the kinds of %', c;
    END IF;
    kinds := kinds || ARRAY['workflow.approval'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, c, kinds);
  END LOOP;
END;
$$;
