-- p18-plan-mode W4 (docs/design/p18-plan-mode.md, "Implementation (W4)") and the p17-chat-flow leftovers
-- (docs/design/p17-chat-flow.md §12). Owner 2026-10-28: "hepsini tamamlayalım".
--
--  * notification kind 'chat.plan': a plan needs a decision, is done, is blocked / waits for its owner, is back in
--    review after the assistant changed its structure (the plan's owner only; deduped per occurrence).
--  * chat_flow_events keys gain `decided:<node run id>` (a workflow approval step decided or closed elsewhere: the
--    conversations showing its card are told once through their stream) and `sched:<automation run id>` (the result of
--    a scheduled run of an automation created in a conversation, posted there once). A scheduled run of a workflow
--    created in a conversation uses the existing `result:<run id>` key (such a run never has a run card).
--  * chat_result_mutes: "Bu sohbete sonuç gönderme" — a conversation's owner turns the scheduled result cards of one
--    automation / workflow off for that conversation (target `automation:<id>` / `workflow:<project>/<name>`).
--  * an index on the confirmed automation / workflow cards (the scheduled-result scan).
--
-- Additive. Rollback: an older master ignores the table, the keys and the kind; to remove:
--   DROP TABLE chat_result_mutes; DROP INDEX chat_drafts_created_cards_idx;
--   DELETE FROM chat_flow_events WHERE key LIKE 'decided:%' OR key LIKE 'sched:%';
--   re-create chat_flow_events_key_check as in 0180;
--   DELETE FROM notifications WHERE kind = 'chat.plan';
--   DELETE FROM notification_preferences WHERE kind = 'chat.plan';
--   and re-create both *_kind_check constraints without it (same block as below).

ALTER TABLE chat_flow_events DROP CONSTRAINT chat_flow_events_key_check;
ALTER TABLE chat_flow_events ADD CONSTRAINT chat_flow_events_key_check CHECK (
  key ~ '^(approval|result|question|decided|sched):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR key ~ '^job:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,19}$'
);

CREATE TABLE chat_result_mutes (
  thread_id   uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  target      text NOT NULL CHECK (target ~ '^(automation:[0-9a-f-]{36}|workflow:[A-Za-z0-9_.:-]{1,128}/.{1,200})$'),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (thread_id, target)
);

CREATE INDEX chat_drafts_created_cards_idx ON chat_drafts (project)
  WHERE state = 'confirmed' AND kind IN ('automation', 'workflow');

-- Notification kinds: appended to whatever the constraints allow now (see 0177 / 0178).
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
    kinds := kinds || ARRAY['chat.plan'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, c, kinds);
  END LOOP;
END;
$$;
