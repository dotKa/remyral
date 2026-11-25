-- p15-workflow-ai (docs/design/p15-workflow-ai.md): a chat thread linked to a workflow — the editor's AI panel keeps its
-- conversation here so the user can continue it later (also from Sohbet). The link is the workflow's project and name
-- (a workflow is every version of one name); an unsaved new workflow's thread has the project only until the editor
-- saves it. Threads stay private per user (every route checks user_id). Written only through src/workflows/ai.ts.
-- Additive only (rollback: leave the columns; older code never reads them). Migration number 0122 (given in the
-- brief); renumber at merge if needed.

ALTER TABLE chat_threads
  ADD COLUMN workflow_project text NULL,
  ADD COLUMN workflow_name text NULL;

ALTER TABLE chat_threads
  ADD CONSTRAINT chat_threads_workflow_link
    CHECK (
      (workflow_name IS NULL OR workflow_project IS NOT NULL)
      AND (workflow_project IS NULL OR workflow_project ~ '^[A-Za-z0-9_.:-]{1,128}$')
      AND (workflow_name IS NULL OR workflow_name ~ '^[a-z][a-z0-9_-]{0,63}$')
    );

CREATE INDEX chat_threads_workflow
  ON chat_threads (user_id, workflow_project, workflow_name, updated_at DESC)
  WHERE workflow_project IS NOT NULL;
