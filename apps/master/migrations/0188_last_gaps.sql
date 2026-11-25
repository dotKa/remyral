-- p18-last-gaps (docs/design/p18-last-gaps.md): engine-1 workflow gates in the chat, and comments on compare views.
--
--  * chat_flow_events keys gain `gate:<run id>:<node id>` (an engine-1 gate — a v1 document's step approval run on
--    engine 1 — announced in the conversations linked to its run, once) and `gatedone:<run id>:<node id>` (its decision
--    or closing told to the conversations showing its card, once). Engine-1 gates have no node-run id; the key names the
--    run and the node (node ids as migration 0017 allows them).
--  * a partial index on engine-1 gates waiting for a decision (the chat flow tick and "Senden bekleyen" scan them).
--  * code_compare_comments: review comments on a compare view of the Kod tab (`/projects/:id/code/compare?base=&head=`),
--    anchored to the project, the two refs as the view names them, the commits they resolved to when the comment was
--    written, the path, the side and a line range. One level of replies; resolved / sent stamps. "Outdated" = the head
--    ref resolves to another commit now (computed, not stored). Nothing here writes to a repository.
--
-- Additive. Rollback: an older master ignores the keys, the index and the table; to remove:
--   DROP TABLE code_compare_comments; DROP INDEX workflow_nodes_gate_wait_idx;
--   DELETE FROM chat_flow_events WHERE key LIKE 'gate:%' OR key LIKE 'gatedone:%';
--   re-create chat_flow_events_key_check as in 0183.

ALTER TABLE chat_flow_events DROP CONSTRAINT chat_flow_events_key_check;
ALTER TABLE chat_flow_events ADD CONSTRAINT chat_flow_events_key_check CHECK (
  key ~ '^(approval|result|question|decided|sched):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR key ~ '^job:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,19}$'
  OR key ~ '^(gate|gatedone):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[a-z][a-z0-9_-]{0,47}(\.[a-z][a-z0-9_-]{0,31})?$'
);

CREATE INDEX workflow_nodes_gate_wait_idx ON workflow_nodes (updated_at)
  WHERE state = 'awaiting_approval' AND gate_role IS NOT NULL AND gate_decision IS NULL;

CREATE TABLE code_compare_comments (
  id          uuid PRIMARY KEY,
  project     text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- The refs as the compare view names them (a branch name or a commit sha).
  base_ref    text NOT NULL CHECK (length(base_ref) BETWEEN 1 AND 255),
  head_ref    text NOT NULL CHECK (length(head_ref) BETWEEN 1 AND 255),
  -- The commits they resolved to when the comment was written (the head moves on: "outdated").
  base_sha    text NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  head_sha    text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  path        text NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
  side        text NOT NULL CHECK (side IN ('old', 'new')),
  start_line  integer NOT NULL CHECK (start_line >= 1),
  end_line    integer NOT NULL CHECK (end_line >= start_line AND end_line <= 1000000),
  parent_id   uuid NULL REFERENCES code_compare_comments (id) ON DELETE CASCADE,
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  author_id   uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  resolved_at timestamptz NULL,
  resolved_by uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  sent_at     timestamptz NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE INDEX code_compare_comments_view_idx ON code_compare_comments (project, base_ref, head_ref, created_at);
CREATE INDEX code_compare_comments_parent_idx ON code_compare_comments (parent_id) WHERE parent_id IS NOT NULL;
