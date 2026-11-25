-- p17-embeddings (docs/design/p17-embeddings.md): the embedding index used across the system — similar past jobs in a
-- job's context and on its page, "this error was solved before" in the failure views, "a similar record exists"
-- before a job or an automation is created, and fewer duplicate auto-fix jobs.
--
--  * work_embeddings: vectors of work items, one per (kind, item). Like search_embeddings only for projects whose
--    search capture is consented, with the same gates (no secret-looking text is ever sent, vectors are never shown):
--      job_card         the job's title and the beginning of its prompt (the text stays in `jobs`; only the vector is
--                       kept here) — what "a similar job" is measured on;
--      job_failure      the error code and the normalised failure message of a failed job;
--      workflow_failure the failed step, its error code and normalised message of a failed workflow run;
--      automation       an automation's name, description and job prompt (duplicate check).
--    `content_hash` is the hash of the embedded text: a changed text is embedded again, an unchanged one never.
--    Rows go when the project's capture is switched off, when the provider's model changes (other vector space) and
--    when the item is gone (indexer pass).
--  * job_related_context: what a job's agent was given as "similar past jobs" (job ids, scores) — the block is
--    computed once, on the job's first context issue, and repeated identically on every later attempt.
--  * related_work_settings: per project, whether jobs get that block (default on; a project admin can turn it off).
--    The platform switches are RELATED_WORK=off (everything) and RELATED_WORK_CONTEXT=off (the block only).
--
-- Additive. Rollback: an older master ignores the tables. To drop: DROP TABLE work_embeddings, job_related_context,
-- related_work_settings.

CREATE TABLE work_embeddings (
  kind          text NOT NULL CHECK (kind IN ('job_card', 'job_failure', 'workflow_failure', 'automation')),
  ref_id        uuid NOT NULL,
  project       text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- job_failure / workflow_failure: the error code (lower-case identifier) the failure carried, when it had one.
  error_code    text NULL CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_.:-]{1,128}$'),
  content_hash  text NOT NULL CHECK (length(content_hash) BETWEEN 8 AND 128),
  model         text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  dims          integer NOT NULL CHECK (dims BETWEEN 1 AND 8192),
  embedding     real[] NOT NULL CHECK (array_ndims(embedding) = 1 AND cardinality(embedding) BETWEEN 1 AND 8192),
  indexed_at    timestamptz NOT NULL,
  PRIMARY KEY (kind, ref_id)
);
CREATE INDEX work_embeddings_project_idx ON work_embeddings (project, kind, model);

CREATE TABLE job_related_context (
  job_id      uuid PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  -- [{jobId, score}] — at most 3, in the order they were given (empty: nothing was similar enough).
  items       jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 3),
  chars       integer NOT NULL CHECK (chars >= 0),
  created_at  timestamptz NOT NULL
);

CREATE TABLE related_work_settings (
  project          text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  context_enabled  boolean NOT NULL DEFAULT true,
  version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at       timestamptz NOT NULL,
  updated_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL
);
