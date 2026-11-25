-- p6-quota-scheduling (docs/design/p6-quota-scheduling.md): which runtime an attempt ran with (fallback runtimes),
-- per-project off-peak windows for deferrable jobs, and "Run now" overrides of a deferral. Additive only.

-- The runtime option an attempt was dispatched with: {index, runtime, model?, modelProfile?, reason?}. NULL for
-- attempts dispatched before this migration and for jobs without fallbacks that ran on their own runtime (index 0
-- is recorded too when a job declares fallbacks). `runtime` is the attempt's effective runtime: queries that need
-- it use COALESCE(runtime_choice->>'runtime', jobs.spec->>'runtime').
ALTER TABLE job_runs
  ADD COLUMN runtime_choice jsonb NULL
    CHECK (
      runtime_choice IS NULL
      OR (jsonb_typeof(runtime_choice) = 'object'
          AND runtime_choice->>'runtime' IN ('claude-code', 'codex', 'pi', 'opencode')
          AND (runtime_choice->>'index')::int BETWEEN 0 AND 3)
    );

-- A project's off-peak window {start: "HH:MM", end: "HH:MM", timeZone: IANA}; NULL = none (deferrable jobs run at
-- once). Validated by the service; the check keeps the shape.
ALTER TABLE projects
  ADD COLUMN off_peak jsonb NULL
    CHECK (
      off_peak IS NULL
      OR (jsonb_typeof(off_peak) = 'object'
          AND off_peak->>'start' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
          AND off_peak->>'end' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
          AND off_peak->>'start' <> off_peak->>'end'
          AND length(off_peak->>'timeZone') BETWEEN 1 AND 64)
    ),
  ADD COLUMN off_peak_updated_by text NULL CHECK (length(off_peak_updated_by) <= 128),
  ADD COLUMN off_peak_updated_at timestamptz NULL;

-- "Run now": a deferred job starts without waiting for the window. One row per job (the first request wins);
-- history in the audit log (`job.run_now`).
CREATE TABLE job_run_now (
  job_id       uuid PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 128),
  requested_at timestamptz NOT NULL
);
