-- p8-templates (docs/design/p8-templates.md): parameterised job templates per project or global, their immutable
-- versions, which jobs / automations came from which template version (usage stats), and each user's feedback on
-- template suggestions. Additive only. Migration number 0069: renumber at merge if a parallel change took it.

CREATE TABLE job_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = global (Settings-wide, created and changed by admins only).
  project          text NULL CHECK (project IS NULL OR project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description      text NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  tags             text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 16),
  state            text NOT NULL CHECK (state IN ('active', 'archived')),
  current_version  integer NOT NULL CHECK (current_version >= 1),
  owner_id         uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  -- Where it came from: {kind: manual | job | draft | suggestion | duplicate, id?}.
  source           jsonb NOT NULL DEFAULT '{"kind":"manual"}'::jsonb CHECK (jsonb_typeof(source) = 'object'),
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  archived_at      timestamptz NULL,
  CHECK ((state = 'archived') = (archived_at IS NOT NULL))
);
CREATE INDEX job_templates_project_idx ON job_templates (project, state, updated_at DESC);

-- Content versions (prompt, typed parameters, run defaults). Never updated or deleted.
CREATE TABLE job_template_versions (
  template_id  uuid NOT NULL REFERENCES job_templates (id) ON DELETE CASCADE,
  version      integer NOT NULL CHECK (version >= 1),
  prompt       text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 65536),
  parameters   jsonb NOT NULL CHECK (jsonb_typeof(parameters) = 'array' AND jsonb_array_length(parameters) <= 30),
  defaults     jsonb NOT NULL CHECK (jsonb_typeof(defaults) = 'object'),
  change_note  text NULL CHECK (change_note IS NULL OR length(change_note) <= 500),
  created_by   uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL,
  PRIMARY KEY (template_id, version)
);

CREATE FUNCTION job_template_versions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'job_template_versions is append-only (% rejected)', TG_OP USING ERRCODE = 'RA000';
END;
$$;
CREATE TRIGGER job_template_versions_no_update
  BEFORE UPDATE ON job_template_versions
  FOR EACH ROW EXECUTE FUNCTION job_template_versions_immutable();

-- One row per job created from a template (composer, chat card, REST); written in the job's creation transaction.
CREATE TABLE job_template_runs (
  job_id       uuid PRIMARY KEY REFERENCES jobs (id),
  template_id  uuid NOT NULL REFERENCES job_templates (id) ON DELETE CASCADE,
  version      integer NOT NULL CHECK (version >= 1),
  via          text NOT NULL CHECK (via IN ('composer', 'chat', 'api')),
  created_at   timestamptz NOT NULL
);
CREATE INDEX job_template_runs_template_idx ON job_template_runs (template_id, created_at DESC);

-- Automations created from a template: their runs' jobs count for the template.
CREATE TABLE job_template_automations (
  automation_id  uuid PRIMARY KEY REFERENCES automations (id) ON DELETE CASCADE,
  template_id    uuid NOT NULL REFERENCES job_templates (id) ON DELETE CASCADE,
  version        integer NOT NULL CHECK (version >= 1),
  params         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object'),
  created_at     timestamptz NOT NULL
);
CREATE INDEX job_template_automations_template_idx ON job_template_automations (template_id);

-- A user's answer to a suggestion: dismissed (hide it), not_similar (its items are kept apart), created (a template was
-- made from it). Per user: suggestions are computed for the viewer from what they may see.
CREATE TABLE job_template_suggestion_feedback (
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project        text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  suggestion_id  text NOT NULL CHECK (suggestion_id ~ '^[0-9a-f]{32}$'),
  kind           text NOT NULL CHECK (kind IN ('dismissed', 'not_similar', 'created')),
  member_keys    text[] NOT NULL DEFAULT '{}' CHECK (cardinality(member_keys) <= 50),
  created_at     timestamptz NOT NULL,
  PRIMARY KEY (user_id, project, suggestion_id)
);
