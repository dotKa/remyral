-- p19-ide W1 (docs/design/p19-ide.md §5, "Implementation (W1)"): review comments of the console's diff reviewer.
-- A comment is anchored to a commit sha + path + side + line range of a job's verified changes; replies point at their
-- thread's first comment. A comment is "outdated" when the job's reviewed head moved since it was written (computed,
-- not stored). "Değişiklik iste" stamps `sent_at` on the comments it carried to the agent (message or follow-up job).
-- Nothing here writes to a repository.
--
-- Additive. Rollback: an older master ignores the table; to remove: DROP TABLE code_review_comments;

CREATE TABLE code_review_comments (
  id          uuid PRIMARY KEY,
  project     text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  job_id      uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  -- The head the comment was written against (the job's verified head then).
  commit_sha  text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  path        text NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
  side        text NOT NULL CHECK (side IN ('old', 'new')),
  start_line  integer NOT NULL CHECK (start_line >= 1),
  end_line    integer NOT NULL CHECK (end_line >= start_line AND end_line <= 1000000),
  parent_id   uuid NULL REFERENCES code_review_comments (id) ON DELETE CASCADE,
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  author_id   uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  resolved_at timestamptz NULL,
  resolved_by uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  sent_at     timestamptz NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE INDEX code_review_comments_job_idx ON code_review_comments (job_id, created_at);
CREATE INDEX code_review_comments_parent_idx ON code_review_comments (parent_id) WHERE parent_id IS NOT NULL;
