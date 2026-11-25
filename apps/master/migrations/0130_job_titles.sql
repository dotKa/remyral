-- p15-job-titles (docs/design/p15-job-titles.md, owner 2026-10-22: "İş başlıkları, PR'lar vs. daha kısa ve anlaşılır
-- olmalı. İş başlığı çok uzun; başlığa yazılan içerik iş açıklamasına yazılmalı gibi."):
--  * job_titles: a job's short title (one line, ≤ 60 characters), separate from its prompt (the description). One row
--    per job, written with the job (JobStore.create: the submitted spec.title, else derived from the prompt) and
--    replaced when someone edits it. A separate table because jobs.spec is immutable after submission and finished
--    jobs are immutable altogether (jobs_guard_update), while a title stays editable (like job_time_limit_changes).
--    source: 'given' (submitter / assistant / sub-job / workflow / automation), 'derived' (deterministic summary of
--    the prompt, also the backfill) or 'edited' (a person changed it; updated_by).
--  * Backfill: existing jobs get a 'derived' row from the master after start-up (JobTitles.backfill, bounded batches,
--    the same TypeScript derivation as new jobs — one rule, no SQL copy of it). Until then readers fall back to
--    deriving the title from the prompt on the fly.
--
-- Rollback: the table is additive; an older master ignores it. Drop it by hand only after a rollback is final:
--   DROP TABLE job_titles;

CREATE TABLE job_titles (
  job_id     uuid PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  title      text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60 AND title !~ '[[:cntrl:]]' AND btrim(title) <> ''),
  source     text NOT NULL CHECK (source IN ('given', 'derived', 'edited')),
  updated_at timestamptz NOT NULL,
  updated_by uuid NULL REFERENCES users (id) ON DELETE SET NULL
);
