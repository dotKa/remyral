-- p8-outputs-folders (docs/design/p8-outputs-folders.md): own folders on the Outputs screen — project folders (shared
-- with the project's members: read viewer, write operator) and personal folders (their creator only). Folders hold
-- LINKS to output items (an item can be in several folders; deleting a folder never touches the item). Jobs and
-- automations may name a folder their outputs are linked into when the job ends.
-- Rows are written only through src/outputs/folders.ts. Migration number 0070: renumber at merge if a parallel change
-- took it.

CREATE TABLE output_folders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       text NOT NULL CHECK (scope IN ('project', 'personal')),
  project     text NULL REFERENCES projects (id) ON DELETE CASCADE,
  owner_id    uuid NULL REFERENCES users (id) ON DELETE CASCADE,
  parent_id   uuid NULL REFERENCES output_folders (id) ON DELETE CASCADE,
  -- A root folder is level 1; at most 6 levels.
  depth       smallint NOT NULL CHECK (depth BETWEEN 1 AND 6),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  note        text NOT NULL DEFAULT '' CHECK (length(note) <= 20000),
  tags        text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 20),
  pinned      boolean NOT NULL DEFAULT false,
  created_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL,
  updated_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL,
  CHECK ((scope = 'project') = (project IS NOT NULL)),
  CHECK ((scope = 'personal') = (owner_id IS NOT NULL)),
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK ((parent_id IS NULL) = (depth = 1))
);
-- Sibling names are unique (case-insensitive) per parent within a project / an owner.
CREATE UNIQUE INDEX output_folders_project_name_idx
  ON output_folders (project, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  WHERE scope = 'project';
CREATE UNIQUE INDEX output_folders_personal_name_idx
  ON output_folders (owner_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  WHERE scope = 'personal';
CREATE INDEX output_folders_parent_idx ON output_folders (parent_id);

-- One item in one folder. `project` + `item_key` address the item exactly as the read model does
-- (site:… / file:<job>:<artifact> / run:<job>:<artifact> / note:<uuid>).
CREATE TABLE output_folder_links (
  folder_id   uuid NOT NULL REFERENCES output_folders (id) ON DELETE CASCADE,
  project     text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_key    text NOT NULL CHECK (item_key ~ '^(site|file|run|note):[A-Za-z0-9_.:+-]+$' AND length(item_key) <= 320),
  -- file / run items: their job (the link goes with the job).
  job_id      uuid NULL REFERENCES jobs (id) ON DELETE CASCADE,
  source      text NOT NULL CHECK (source IN ('user', 'job')),
  added_by    uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  added_at    timestamptz NOT NULL,
  PRIMARY KEY (folder_id, project, item_key)
);
CREATE INDEX output_folder_links_item_idx ON output_folder_links (project, item_key);

-- A job whose outputs are linked into a folder when it ends (checked at creation and again at link time).
CREATE TABLE job_output_folders (
  job_id        uuid PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  folder_id     uuid NULL REFERENCES output_folders (id) ON DELETE SET NULL,
  requested_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  via           text NOT NULL CHECK (via IN ('api', 'automation')),
  created_at    timestamptz NOT NULL,
  linked        integer NOT NULL DEFAULT 0,
  done_at       timestamptz NULL,
  outcome       text NULL CHECK (outcome IN ('linked', 'refused')),
  reason        text NULL CHECK (reason IS NULL OR length(reason) <= 300),
  CHECK ((done_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX job_output_folders_pending_idx ON job_output_folders (created_at) WHERE done_at IS NULL;

-- An automation job target's folder (null: none). Folder deleted → the automation keeps running without it.
ALTER TABLE automations ADD COLUMN output_folder_id uuid NULL REFERENCES output_folders (id) ON DELETE SET NULL;
