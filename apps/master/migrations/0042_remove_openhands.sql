-- ADR-0023: OpenHands was removed from the platform (runtime, adapter, installer, interactive Canvas sessions).
-- This migration changes *configuration* only. History is never deleted or rewritten: jobs, attempts, events,
-- usage, context bundle deliveries, audit events and worker_runtimes rows that name OpenHands stay readable, and
-- the CHECK constraints of those tables keep accepting 'openhands'.
--
-- What the master does at start-up instead (src/runtime-retirement, idempotent): cancel unfinished OpenHands jobs
-- and sessions through the job state machine, write worker-configuration generations (cause 'runtime_removed') and
-- runtime-policy versions without OpenHands — both are append-only, hash-covered documents that SQL cannot rewrite.
--
-- Rollback: `git revert` of the code; the profiles archived below can be copied back from retired_model_profiles.
-- Migration number 0042: renumber at merge if a parallel change took it.

-- The interactive-session list / proxy lookup index (0020) has no reader any more.
DROP INDEX IF EXISTS jobs_interactive_idx;

-- A worker configuration generation that only drops the removed runtime.
ALTER TABLE worker_config_versions DROP CONSTRAINT worker_config_versions_cause_check;
ALTER TABLE worker_config_versions ADD CONSTRAINT worker_config_versions_cause_check
  CHECK (cause IN ('edit', 'bulk', 'project', 'rollback', 'adopt', 'repository', 'catalog', 'workspace',
                   'unconfined', 'login', 'machine_admin', 'skills_key', 'runtime_removed'));

-- Model catalog entries as they were before this migration changed or removed them (rollback evidence; never read
-- by the master). One row per touched entry.
CREATE TABLE retired_model_profiles (
  id           text NOT NULL,
  entry        jsonb NOT NULL CHECK (jsonb_typeof(entry) = 'object'),
  version      integer NOT NULL,
  -- 'removed': the entry served only OpenHands and was deleted; 'changed': OpenHands, baseUrl and headers were
  -- dropped from it (a new version stays in model_catalog).
  action       text NOT NULL CHECK (action IN ('removed', 'changed')),
  reason       text NOT NULL CHECK (reason = 'runtime_removed'),
  archived_at  timestamptz NOT NULL,
  PRIMARY KEY (id, version)
);

INSERT INTO retired_model_profiles (id, entry, version, action, reason, archived_at)
SELECT c.id, c.entry, c.version,
       CASE WHEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.entry->'runtimes') r WHERE r <> 'openhands')
            THEN 'removed' ELSE 'changed' END,
       'runtime_removed', now()
  FROM model_catalog c
 WHERE c.entry->'runtimes' ? 'openhands' OR c.entry ? 'baseUrl' OR c.entry ? 'headers';

-- Defaults of the removed runtime, and any default pointing at a profile that is removed below.
DELETE FROM model_defaults WHERE runtime = 'openhands';
DELETE FROM model_defaults
 WHERE profile_id IN (SELECT id FROM retired_model_profiles WHERE action = 'removed');

-- Profiles that served only OpenHands.
DELETE FROM model_catalog WHERE id IN (SELECT id FROM retired_model_profiles WHERE action = 'removed');

-- The others lose OpenHands and the OpenHands-only fields (LiteLLM base URL and extra request headers).
UPDATE model_catalog c
   SET entry = jsonb_set(
         c.entry - 'baseUrl' - 'headers',
         '{runtimes}',
         COALESCE((SELECT jsonb_agg(r) FROM jsonb_array_elements(c.entry->'runtimes') r WHERE r <> '"openhands"'::jsonb),
                  '[]'::jsonb)),
       version = c.version + 1,
       updated_at = now(),
       updated_by = NULL
 WHERE c.id IN (SELECT id FROM retired_model_profiles WHERE action = 'changed');

-- The latest capability snapshot of OpenHands is no longer current on any worker (the rows stay as history).
UPDATE worker_runtimes SET present = false WHERE runtime = 'openhands' AND present;
