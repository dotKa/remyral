-- p6-outputs (docs/design/p6-outputs.md): one screen for what jobs produced — live sites (the latest successful
-- deploy per project, target and environment), files (workspace job outputs and run artifacts) and notes.
-- The read model aggregates existing rows (ops_actions, job_artifacts, job_events); this migration only adds the
-- people's own metadata on top: custom title, tags, pin and a notes thread per item, and free-standing note cards.
-- Rows are written only through src/outputs. Notes are NOT context documents (never sent to an agent).
-- Migration number 0060: renumber at merge if a parallel change took it.

-- Metadata of one output item, addressed by its item key (site:… / file:<job>:<artifact> / run:<job>:<artifact>).
-- A row exists only once someone titled, tagged, pinned or noted the item.
CREATE TABLE output_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project     text NOT NULL REFERENCES projects (id),
  item_key    text NOT NULL CHECK (item_key ~ '^(site|file|run):[A-Za-z0-9_.:+-]+$' AND length(item_key) <= 320),
  kind        text NOT NULL CHECK (kind IN ('site', 'file', 'run')),
  -- file / run: the job and artifact the key names (the retention sweeps look pinned files up by these).
  job_id      uuid NULL REFERENCES jobs (id) ON DELETE CASCADE,
  artifact_id text NULL CHECK (artifact_id IS NULL OR length(artifact_id) BETWEEN 1 AND 128),
  title       text NULL CHECK (title IS NULL OR length(title) BETWEEN 1 AND 200),
  tags        text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 20),
  -- Pinned files are exempt from the workspace retention / quota sweeps and the live-event retention.
  pinned      boolean NOT NULL DEFAULT false,
  pinned_by   uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  pinned_at   timestamptz NULL,
  created_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL,
  updated_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL,
  UNIQUE (project, item_key),
  CHECK ((kind = 'site') = (job_id IS NULL)),
  CHECK ((job_id IS NULL) = (artifact_id IS NULL)),
  CHECK (pinned = (pinned_at IS NOT NULL))
);
CREATE INDEX output_items_pinned_file_idx ON output_items (job_id, artifact_id) WHERE pinned;
CREATE INDEX output_items_tags_idx ON output_items USING gin (tags);

-- The notes thread of an item (markdown text, rendered as text by the console; edit/delete own, admins any).
CREATE TABLE output_item_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES output_items (id) ON DELETE CASCADE,
  project     text NOT NULL REFERENCES projects (id),
  author_id   uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
CREATE INDEX output_item_notes_item_idx ON output_item_notes (item_id, created_at);

-- Free-standing note cards of a project (title, markdown body, tags, pin, https links).
CREATE TABLE output_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project     text NOT NULL REFERENCES projects (id),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body        text NOT NULL CHECK (length(body) <= 20000),
  tags        text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 20),
  pinned      boolean NOT NULL DEFAULT false,
  links       text[] NOT NULL DEFAULT '{}' CHECK (cardinality(links) <= 20),
  author_id   uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL,
  updated_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL
);
CREATE INDEX output_notes_project_idx ON output_notes (project, updated_at DESC);

-- Read model: run artifacts across jobs (the existing kind index leads with job_id).
CREATE INDEX job_events_artifact_idx ON job_events (job_id) WHERE kind = 'artifact';
-- Read model: live sites (succeeded deploys by project).
CREATE INDEX ops_actions_succeeded_deploy_idx ON ops_actions (project, finished_at DESC)
  WHERE state = 'succeeded' AND kind IN ('pages.deploy', 'pages.rollback', 'coolify.deploy', 'coolify.rollback');
