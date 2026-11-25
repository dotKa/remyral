-- p18-project-bootstrap (docs/design/p18-project-bootstrap.md §5): a project's PREFERRED machines — the minimal
-- project-level placement default the chat's draft_project_machines and Projeler → Makineler set. Every job of the
-- project scores these machines higher (the scheduler's soft preference, PREFERRED_WORKER_BONUS); it is never a
-- requirement: another eligible machine still runs the job when the preferred ones are offline, busy or unable.
--
-- One row per project; at most 16 machine ids (enrolled workers at the time of the write; a machine removed later is
-- simply never a candidate). No secrets.
--
-- Additive. Rollback: an older master ignores the table (no preference); to remove: DROP TABLE project_preferred_workers;

CREATE TABLE project_preferred_workers (
  project     text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  worker_ids  text[] NOT NULL DEFAULT '{}'
              CHECK (cardinality(worker_ids) <= 16 AND array_position(worker_ids, NULL) IS NULL),
  updated_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL
);
