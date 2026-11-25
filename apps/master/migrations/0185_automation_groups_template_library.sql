-- p18-multi-project W4 (docs/design/p18-multi-project.md §2.2, §2.5, §4 items 5 and 8, "Built: W4"). Owner 2026-10-28:
-- "hepsini tamamlayalım".
--
--  * automation_groups + automations.group_id / diverged: "Projeler" in the automation form creates one ordinary
--    automation per selected project (each authorized on its own, run-as / webhook secret / history stay per project),
--    linked by group_id. "Tümüne uygula" changes every sibling the editor may change; the others are marked diverged
--    (as is a sibling changed on its own). A group never grants anything: each row keeps its project's rules.
--  * job_template_shares: a project template offered to listed projects or '*' (every project). The target reads and
--    runs it in its own project under its own policy; editing stays with the owner project.
--  * job_template_hidden: a target project hides a global or shared template from its library.
--
-- Additive. Rollback: an older master ignores the tables and columns (grouped automations keep working one by one,
-- shared templates are simply not visible outside their project); to remove:
--   DROP TABLE job_template_hidden; DROP TABLE job_template_shares;
--   ALTER TABLE automations DROP COLUMN diverged, DROP COLUMN group_id; DROP TABLE automation_groups;

CREATE TABLE automation_groups (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL,
  updated_by  uuid NULL REFERENCES users (id),
  updated_at  timestamptz NULL
);

ALTER TABLE automations
  ADD COLUMN group_id uuid NULL REFERENCES automation_groups (id) ON DELETE SET NULL,
  -- The sibling no longer matches the group's last "Tümüne uygula" (changed on its own, or skipped by one).
  ADD COLUMN diverged boolean NOT NULL DEFAULT false;
CREATE INDEX automations_group_idx ON automations (group_id) WHERE group_id IS NOT NULL;

CREATE TABLE job_template_shares (
  template_id  uuid NOT NULL REFERENCES job_templates (id) ON DELETE CASCADE,
  -- '*' = every project; else one project id (never the template's own project — checked by the service).
  project      text NOT NULL CHECK (project = '*' OR project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  shared_by    uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  shared_at    timestamptz NOT NULL,
  PRIMARY KEY (template_id, project)
);
CREATE INDEX job_template_shares_project_idx ON job_template_shares (project);

CREATE TABLE job_template_hidden (
  template_id  uuid NOT NULL REFERENCES job_templates (id) ON DELETE CASCADE,
  project      text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  hidden_by    uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  hidden_at    timestamptz NOT NULL,
  PRIMARY KEY (template_id, project)
);
CREATE INDEX job_template_hidden_project_idx ON job_template_hidden (project);
