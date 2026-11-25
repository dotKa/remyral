-- p15-workspace-retention (docs/design/p15-workspace-retention.md): kept working directories of repository-less
-- (workspace) jobs on their machines — the master's records ("Çalışma dosyaları"), follow-up seeds, the retention
-- policy (Ayarlar + per project) and exports (repository import / site upload).
--
--  * job_workfiles       one row per kept attempt directory, reconciled with the worker's reports (CAPABILITIES
--                        `workfiles`, WORKFILES_STATUS). kept → deleting (asked, machine offline) → deleted; lost when
--                        the machine no longer has it. The files themselves never leave the machine unless read.
--  * job_workfile_seeds  a job that starts from another job's kept files (follow-up, run again, fix, deploy retry);
--                        while it is not finished it pins the source.
--  * workfiles_settings  retention days (0 = delete at the end as before) and the per-machine cap.
--  * project_workspaces.workfiles_retention_days  a project's own retention (NULL = the global one).
--  * workfile_exports    "Repoya aktar" (branch + pull request / new private repository) and site uploads from kept
--                        files, with their outcome.
--  * chat_drafts.kind    + workfiles_export (the assistant's export_workfiles).

CREATE TABLE job_workfiles (
  attempt_id     uuid PRIMARY KEY,
  job_id         uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  worker_id      text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  project        text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  outcome        text NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'cancelled')),
  state          text NOT NULL CHECK (state IN ('kept', 'deleting', 'deleted', 'lost')),
  size_bytes     bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  file_count     integer NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  dropped        integer NOT NULL DEFAULT 0 CHECK (dropped >= 0),
  redacted       integer NOT NULL DEFAULT 0 CHECK (redacted >= 0),
  kept_at        timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  -- Set while a pending deploy / service / follow-up needs the files (never evicted or expired before it).
  pinned_until   timestamptz NULL,
  pin_reason     text NULL CHECK (pin_reason IS NULL OR length(pin_reason) <= 200),
  delete_reason  text NULL CHECK (delete_reason IS NULL OR delete_reason IN ('user', 'expired', 'evicted', 'missing')),
  deleted_by     text NULL CHECK (deleted_by IS NULL OR length(deleted_by) <= 128),
  deleted_at     timestamptz NULL,
  updated_at     timestamptz NOT NULL
);
CREATE INDEX job_workfiles_job ON job_workfiles (job_id, kept_at DESC);
CREATE INDEX job_workfiles_worker ON job_workfiles (worker_id, state, kept_at);
CREATE INDEX job_workfiles_project ON job_workfiles (project, state, kept_at DESC);

CREATE TABLE job_workfile_seeds (
  job_id             uuid PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  source_job_id      uuid NOT NULL,
  source_attempt_id  uuid NOT NULL,
  created_at         timestamptz NOT NULL
);
CREATE INDEX job_workfile_seeds_source ON job_workfile_seeds (source_attempt_id);

CREATE TABLE workfiles_settings (
  id                 smallint PRIMARY KEY CHECK (id = 1),
  retention_days     integer NOT NULL DEFAULT 14 CHECK (retention_days BETWEEN 0 AND 365),
  machine_cap_bytes  bigint NOT NULL DEFAULT 10737418240
                       CHECK (machine_cap_bytes BETWEEN 268435456 AND 1099511627776),
  updated_by         uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL
);
INSERT INTO workfiles_settings (id, retention_days, machine_cap_bytes, updated_at)
VALUES (1, 14, 10737418240, now());

ALTER TABLE project_workspaces
  ADD COLUMN workfiles_retention_days integer NULL
    CHECK (workfiles_retention_days IS NULL OR workfiles_retention_days BETWEEN 0 AND 365);

CREATE TABLE workfile_exports (
  id                   uuid PRIMARY KEY,
  job_id               uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  attempt_id           uuid NOT NULL,
  target_project       text NOT NULL CHECK (target_project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  mode                 text NOT NULL CHECK (mode IN ('branch_pr', 'new_repo', 'site_upload')),
  state                text NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
  directory            text NULL CHECK (directory IS NULL OR length(directory) <= 512),
  branch               text NULL CHECK (branch IS NULL OR length(branch) <= 255),
  commit_sha           text NULL CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  pull_request_number  integer NULL,
  pull_request_url     text NULL CHECK (pull_request_url IS NULL OR length(pull_request_url) <= 512),
  repository_url       text NULL CHECK (repository_url IS NULL OR length(repository_url) <= 512),
  site_upload_id       uuid NULL,
  files                integer NOT NULL DEFAULT 0,
  bytes                bigint NOT NULL DEFAULT 0,
  error                text NULL CHECK (error IS NULL OR length(error) <= 1000),
  via                  text NOT NULL CHECK (via IN ('api', 'chat')),
  created_by           uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL,
  finished_at          timestamptz NULL
);
CREATE INDEX workfile_exports_job ON workfile_exports (job_id, created_at DESC);

-- Chat draft kind `workfiles_export`, appended to whatever the constraint allows now (same helper as 0129).
CREATE FUNCTION pg_temp.widen_check_0132(t text, c text, col text, extra text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  def text;
  vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = c AND conrelid = t::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint % not found', c;
  END IF;
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
SELECT pg_temp.widen_check_0132('chat_drafts', 'chat_drafts_kind_check', 'kind', ARRAY['workfiles_export']);
