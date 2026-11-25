-- p18-multi-project W3 + W5 (docs/design/p18-multi-project.md §2.3, §2.4, "Built: W3 + W5") and the project chips of
-- p18-plan-mode W4 (backlog p18-plan-mode-w4-projects). Owner 2026-10-28: "hepsini tamamlayalım".
--
--  * chat_thread_projects: the conversation's further working projects. The set = chat_threads.project (the primary,
--    its sharing switch stays chat_threads.project_share) ∪ these rows (max 7 more — 8 in all, checked by the service).
--    Each member has its own "Proje bilgisiyle paylaş" switch (`share`).
--  * job_batches / job_batch_members: one submission that became one ordinary job per selected project ("Her projeye
--    ayrı iş"). `jobs` is not altered; a refused project keeps its refusal (code + message) instead of a job.
--  * chat_drafts.kind + 'thread_projects' (set_thread_projects), 'workflow_attach' (attach_workflow) and 'job_batch'
--    (draft_job_batch).
--
-- Additive. Rollback: an older master ignores the tables and never lists such cards; to remove:
--   DELETE FROM chat_drafts WHERE kind IN ('thread_projects', 'workflow_attach', 'job_batch');
--   DROP TABLE job_batch_members; DROP TABLE job_batches; DROP TABLE chat_thread_projects;
--   (chat_drafts_kind_check keeps the three values harmlessly.)

CREATE TABLE chat_thread_projects (
  thread_id  uuid NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  project    text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  share      boolean NOT NULL DEFAULT true,
  added_by   uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  added_at   timestamptz NOT NULL,
  PRIMARY KEY (thread_id, project)
);
CREATE INDEX chat_thread_projects_project_idx ON chat_thread_projects (project);

CREATE TABLE job_batches (
  id          uuid PRIMARY KEY,
  created_by  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  -- The submitted base spec (prompt, runtime, chosen settings) — never secrets (jobs specs carry none).
  spec        jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object' AND octet_length(spec::text) <= 65536),
  source      text NOT NULL CHECK (source IN ('console', 'chat')),
  thread_id   uuid NULL REFERENCES chat_threads (id) ON DELETE SET NULL,
  draft_id    uuid NULL,
  created_at  timestamptz NOT NULL
);
CREATE INDEX job_batches_creator_idx ON job_batches (created_by, created_at DESC);

CREATE TABLE job_batch_members (
  batch_id  uuid NOT NULL REFERENCES job_batches (id) ON DELETE CASCADE,
  project   text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  position  smallint NOT NULL CHECK (position BETWEEN 0 AND 31),
  job_id    uuid NULL REFERENCES jobs (id) ON DELETE SET NULL,
  -- {code, message} when the project was refused at submit (no job).
  refusal   jsonb NULL CHECK (refusal IS NULL OR jsonb_typeof(refusal) = 'object'),
  PRIMARY KEY (batch_id, project)
);
CREATE INDEX job_batch_members_job_idx ON job_batch_members (job_id) WHERE job_id IS NOT NULL;

-- Widening a closed CHECK list keeps every value an earlier migration allowed.
CREATE FUNCTION pg_temp.widen_check_0184(t text, c text, col text, extra text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  def text;
  vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = c AND conrelid = t::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint % not found', c;
  END IF;
  -- Either `col = ANY ('{a,b}'::text[])` (written by an earlier widening) or `col IN ('a', 'b')`.
  IF def ~ '\{' THEN
    vals := string_to_array(substring(def from '\{([^}]*)\}'), ',');
  ELSE
    SELECT array_agg(DISTINCT m[1]) INTO vals FROM regexp_matches(def, '''([A-Za-z0-9_.:-]+)''', 'g') AS m;
  END IF;
  IF coalesce(array_length(vals, 1), 0) < 2 THEN
    RAISE EXCEPTION 'could not read the values of %', c;
  END IF;
  vals := vals || extra;
  SELECT array_agg(DISTINCT v ORDER BY v) INTO vals FROM unnest(vals) AS v;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I = ANY (%L::text[]))', t, c, col, vals);
END
$$;

SELECT pg_temp.widen_check_0184('chat_drafts', 'chat_drafts_kind_check', 'kind',
  ARRAY['thread_projects', 'workflow_attach', 'job_batch']);
