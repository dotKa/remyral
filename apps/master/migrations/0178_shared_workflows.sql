-- p18-multi-project W1 + W2 (docs/design/p18-multi-project.md §2.1, §4): shared workflows. A workflow lives in its
-- owner project (workflow_definitions, unchanged); the owner project's admin offers it to projects (`*` = every
-- project), a target project's admin attaches it. Every run belongs to the project it ran in
-- (workflow_runs.project = target) and records the attachment it ran through.
--
--  * workflow_shares: the offers (owner project + name → a project or '*').
--  * workflow_attachments: a target project's use of an owner's workflow — state, version line (follow / pin, the
--    version it runs, a pending version waiting for the target admin), validated overrides (input defaults,
--    repository, approver roles that only raise, error workflow, retention, triggers, concurrency).
--  * workflow_attachment_credentials: every vault credential id written in the definition is a slot; in a target it
--    resolves only through a binding the target's admin set (never to the owner's credential).
--  * workflow_runs.attachment_id: NULL for runs in the owner project (every existing run); immutable identity.
--  * notification kind 'workflow.update_pending' (a version waits for the target admin's acceptance).
--
-- Additive. Rollback: older code ignores the tables and the column (shared runs keep a valid `project`); to remove:
--   ALTER TABLE workflow_runs DROP COLUMN attachment_id (after restoring the 0112 guard);
--   DROP TABLE workflow_attachment_credentials, workflow_attachments, workflow_shares;
--   DELETE FROM notifications WHERE kind = 'workflow.update_pending';
--   DELETE FROM notification_preferences WHERE kind = 'workflow.update_pending';
--   and re-create both *_kind_check constraints without it (same block as below).

CREATE TABLE workflow_shares (
  owner_project  text NOT NULL REFERENCES projects (id),
  name           text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]{0,63}$'),
  -- '*' = every project (except the owner); else one project id.
  project        text NOT NULL CHECK (project = '*' OR project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  offered_by     text NOT NULL CHECK (length(offered_by) BETWEEN 1 AND 128),
  offered_at     timestamptz NOT NULL,
  PRIMARY KEY (owner_project, name, project),
  CHECK (project <> owner_project)
);
CREATE INDEX workflow_shares_project_idx ON workflow_shares (project);

CREATE TABLE workflow_attachments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project          text NOT NULL REFERENCES projects (id),
  owner_project    text NOT NULL REFERENCES projects (id),
  name             text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]{0,63}$'),
  state            text NOT NULL CHECK (state IN ('enabled', 'disabled', 'detached')),
  follow           text NOT NULL CHECK (follow IN ('auto', 'pin')),
  -- The owner's version this project runs.
  version          integer NOT NULL CHECK (version >= 1),
  -- A newer owner version that waits for the target admin (privileged delta or incompatible inputs).
  pending_version  integer NULL CHECK (pending_version IS NULL OR pending_version >= 1),
  pending_reason   text NULL CHECK (pending_reason IS NULL OR pending_reason IN ('privileged', 'inputs', 'privileged_inputs')),
  overrides        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(overrides) = 'object'),
  created_by       text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  created_at       timestamptz NOT NULL,
  updated_by       text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  updated_at       timestamptz NOT NULL,
  detached_at      timestamptz NULL,
  CHECK (project <> owner_project),
  CHECK ((state = 'detached') = (detached_at IS NOT NULL)),
  CHECK ((pending_version IS NULL) = (pending_reason IS NULL))
);
-- A project's namespace: one live attachment per name (own-vs-attached collisions: service + advisory lock).
CREATE UNIQUE INDEX workflow_attachments_live_idx ON workflow_attachments (project, name) WHERE state <> 'detached';
CREATE INDEX workflow_attachments_owner_idx ON workflow_attachments (owner_project, name);

CREATE TABLE workflow_attachment_credentials (
  attachment_id  uuid NOT NULL REFERENCES workflow_attachments (id),
  -- The vault credential id written in the owner's definition.
  slot           text NOT NULL CHECK (slot ~ '^[a-z0-9][a-z0-9_-]{0,47}$'),
  credential_id  text NOT NULL REFERENCES vault_credentials (id) ON DELETE RESTRICT,
  bound_by       text NOT NULL CHECK (length(bound_by) BETWEEN 1 AND 128),
  bound_at       timestamptz NOT NULL,
  PRIMARY KEY (attachment_id, slot)
);

ALTER TABLE workflow_runs ADD COLUMN attachment_id uuid NULL REFERENCES workflow_attachments (id);
CREATE INDEX workflow_runs_attachment_idx ON workflow_runs (attachment_id) WHERE attachment_id IS NOT NULL;

-- The 0112 guard with attachment_id added to the immutable identity.
CREATE OR REPLACE FUNCTION workflow_runs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workflow_runs rows cannot be deleted' USING ERRCODE = 'RA000';
  END IF;
  IF (NEW.id, NEW.definition_id, NEW.project, NEW.inputs, NEW.repository, NEW.created_by, NEW.created_at,
      NEW.engine, NEW.parent_run_id, NEW.parent_node_run_id, NEW.rerun_of, NEW.rerun_from_node, NEW.trigger_kind,
      NEW.source_trust, NEW.concurrency_key, NEW.trigger_node, NEW.error_of, NEW.attachment_id)
     IS DISTINCT FROM
     (OLD.id, OLD.definition_id, OLD.project, OLD.inputs, OLD.repository, OLD.created_by, OLD.created_at,
      OLD.engine, OLD.parent_run_id, OLD.parent_node_run_id, OLD.rerun_of, OLD.rerun_from_node, OLD.trigger_kind,
      OLD.source_trust, OLD.concurrency_key, OLD.trigger_node, OLD.error_of, OLD.attachment_id) THEN
    RAISE EXCEPTION 'workflow run % identity columns are immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'cancelled') THEN
    IF OLD.data_pruned_at IS NULL AND NEW.data_pruned_at IS NOT NULL
       AND (NEW.trigger_data IS NOT DISTINCT FROM OLD.trigger_data
            OR NEW.trigger_data IS NOT DISTINCT FROM '{"$pruned": true}'::jsonb)
       AND (NEW.outputs IS NOT DISTINCT FROM OLD.outputs
            OR NEW.outputs IS NOT DISTINCT FROM '{"$pruned": true}'::jsonb)
       AND (NEW.state, NEW.reason, NEW.ended_at, NEW.version, NEW.name, NEW.priority, NEW.activated_at,
            NEW.paused_ms, NEW.paused_at, NEW.paused_by)
           IS NOT DISTINCT FROM
           (OLD.state, OLD.reason, OLD.ended_at, OLD.version, OLD.name, OLD.priority, OLD.activated_at,
            OLD.paused_ms, OLD.paused_at, OLD.paused_by) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'workflow run % is finished and immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF OLD.trigger_data IS NOT NULL AND NEW.trigger_data IS DISTINCT FROM OLD.trigger_data THEN
    RAISE EXCEPTION 'workflow run % trigger data is immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;

-- Notification kinds: appended to whatever the constraints allow now (see 0139 / 0142 / 0166 / 0177).
DO $$
DECLARE
  t text;
  c text;
  def text;
  kinds text[];
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_preferences'] LOOP
    c := t || '_kind_check';
    SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
     WHERE conname = c AND conrelid = t::regclass;
    IF def IS NULL THEN
      RAISE EXCEPTION 'constraint % not found', c;
    END IF;
    IF def ~ '\{' THEN
      kinds := string_to_array(substring(def from '\{([^}]*)\}'), ',');
    ELSE
      SELECT array_agg(DISTINCT m[1]) INTO kinds FROM regexp_matches(def, '''([a-z0-9_.]+)''', 'g') AS m;
    END IF;
    IF coalesce(array_length(kinds, 1), 0) < 2 THEN
      RAISE EXCEPTION 'could not read the kinds of %', c;
    END IF;
    kinds := kinds || ARRAY['workflow.update_pending'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, c, kinds);
  END LOOP;
END;
$$;
