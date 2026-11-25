-- p6-automations (ADR-0024, docs/design/p6-automations.md): first-class automations — a trigger (cron, one-shot
-- time, GitHub event, signed webhook, job chain) starting a job or a workflow run, with one row per trigger
-- occurrence. Replaces p5-composer's job_schedules (dropped: unused in production). Rows are written only through
-- src/automations.
-- Migration number 0043: renumber at merge if a parallel change took it.

CREATE TABLE automations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project                text NOT NULL REFERENCES projects (id),
  name                   text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description            text NULL CHECK (length(description) <= 2000),
  -- active: triggers are accepted; paused: by a user; done: a one-shot fired; failed: the run-as user lost the
  -- right to submit (re-checked at every run) — stopped; deleted: soft delete (the run history stays).
  state                  text NOT NULL CHECK (state IN ('active', 'paused', 'done', 'failed', 'deleted')),
  trigger_kind           text NOT NULL CHECK (trigger_kind IN ('cron', 'at', 'github', 'webhook', 'chain')),
  -- The validated trigger configuration of the kind (zod on write; see AutomationTrigger).
  trigger                jsonb NOT NULL CHECK (jsonb_typeof(trigger) = 'object'),
  -- Schedule kinds: the expression (minute hour day-of-month month day-of-week, UTC) or the one time.
  cron                   text NULL CHECK (cron IS NULL OR length(cron) BETWEEN 9 AND 120),
  run_at                 timestamptz NULL,
  CHECK ((trigger_kind = 'cron') = (cron IS NOT NULL)),
  CHECK ((trigger_kind = 'at') = (run_at IS NOT NULL)),
  -- Due time of an active schedule (cron/at); NULL for every other kind and state.
  next_run_at            timestamptz NULL,
  CHECK (next_run_at IS NULL OR (state = 'active' AND trigger_kind IN ('cron', 'at'))),
  -- GitHub kind: routing keys (lower-case owner/name, event name).
  github_repo            text NULL CHECK (github_repo IS NULL OR github_repo ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'),
  github_event           text NULL CHECK (github_event IS NULL OR github_event IN ('pull_request', 'push', 'issues', 'issue_comment')),
  CHECK ((trigger_kind = 'github') = (github_repo IS NOT NULL AND github_event IS NOT NULL)),
  -- Chain kind: the automation whose runs start this one (same project, enforced by the service).
  chain_source_id        uuid NULL REFERENCES automations (id),
  CHECK ((trigger_kind = 'chain') = (chain_source_id IS NOT NULL)),
  -- Webhook kind: the HMAC secret, sealed (AES-256-GCM, HKDF sub-key automation-webhook, AAD automation-webhook:<id>);
  -- never returned after creation/rotation. The hint is a public sha256 prefix for "which secret is this".
  webhook_secret         bytea NULL,
  webhook_secret_hint    text NULL CHECK (webhook_secret_hint IS NULL OR webhook_secret_hint ~ '^[a-f0-9]{8}$'),
  webhook_secret_rotated_at timestamptz NULL,
  CHECK ((trigger_kind = 'webhook') = (webhook_secret IS NOT NULL)),
  -- Target: exactly as job_schedules (a validated protocol JobSpec template, or a workflow definition).
  target_kind            text NOT NULL CHECK (target_kind IN ('job', 'workflow')),
  job_spec               jsonb NULL CHECK (job_spec IS NULL OR jsonb_typeof(job_spec) = 'object'),
  priority               integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  workflow_id            uuid NULL REFERENCES workflow_definitions (id),
  workflow_inputs        jsonb NULL CHECK (workflow_inputs IS NULL OR jsonb_typeof(workflow_inputs) = 'object'),
  workflow_repository    jsonb NULL CHECK (workflow_repository IS NULL OR jsonb_typeof(workflow_repository) = 'object'),
  CHECK ((target_kind = 'job') = (job_spec IS NOT NULL)),
  CHECK ((target_kind = 'workflow') = (workflow_id IS NOT NULL)),
  -- Policies (design §5/§6).
  concurrency            text NOT NULL DEFAULT 'skip' CHECK (concurrency IN ('skip', 'queue', 'parallel')),
  catch_up               text NOT NULL DEFAULT 'once' CHECK (catch_up IN ('skip', 'once', 'all')),
  max_runs_per_hour      integer NOT NULL DEFAULT 30 CHECK (max_runs_per_hour BETWEEN 1 AND 120),
  notify_on_failure      boolean NOT NULL DEFAULT true,
  -- Whose rights every run is checked against and who authors the jobs: the creator, or the last user who changed
  -- the trigger or the target.
  run_as                 uuid NOT NULL REFERENCES users (id),
  run_count              integer NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  last_run_id            uuid NULL,
  last_run_state         text NULL,
  last_run_at            timestamptz NULL,
  created_by             uuid NOT NULL REFERENCES users (id),
  created_at             timestamptz NOT NULL,
  updated_by             uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL,
  deleted_by             uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  deleted_at             timestamptz NULL,
  CHECK ((state = 'deleted') = (deleted_at IS NOT NULL))
);
CREATE INDEX automations_due_idx ON automations (next_run_at) WHERE next_run_at IS NOT NULL;
CREATE INDEX automations_project_idx ON automations (project, created_at DESC);
CREATE INDEX automations_github_idx ON automations (github_repo, github_event) WHERE state = 'active';
CREATE INDEX automations_chain_idx ON automations (chain_source_id) WHERE state = 'active';

-- One row per trigger occurrence. UNIQUE (automation_id, dedup_key) is the at-least-once guard: a GitHub redelivery,
-- a retried webhook (same nonce), two sweepers on the same cron tick, or a chain evaluated twice insert nothing new.
CREATE TABLE automation_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id        uuid NOT NULL REFERENCES automations (id),
  project              text NOT NULL REFERENCES projects (id),
  trigger_kind         text NOT NULL CHECK (trigger_kind IN ('cron', 'at', 'github', 'webhook', 'chain', 'manual')),
  dedup_key            text NOT NULL CHECK (length(dedup_key) BETWEEN 1 AND 200),
  scheduled_for        timestamptz NULL,
  -- sha256:<hex> of the raw request body (GitHub, webhook).
  payload_digest       text NULL CHECK (payload_digest IS NULL OR payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  -- Display summary (event, action, number, branch, actor, title …) and the bounded, allow-listed event data the
  -- job receives as fenced untrusted data in its context bundle. Neither is ever an instruction.
  event_summary        jsonb NULL CHECK (event_summary IS NULL OR jsonb_typeof(event_summary) = 'object'),
  event_data           jsonb NULL CHECK (event_data IS NULL OR (jsonb_typeof(event_data) = 'object' AND octet_length(event_data::text) <= 70000)),
  source_trust         text NOT NULL DEFAULT 'trusted' CHECK (source_trust IN ('trusted', 'untrusted')),
  -- queued → starting → running → succeeded | failed | cancelled; or skipped / error (never started).
  state                text NOT NULL CHECK (state IN ('queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled',
                                                      'skipped', 'error')),
  reason               text NULL CHECK (length(reason) <= 1000),
  job_id               uuid NULL REFERENCES jobs (id),
  workflow_run_id      uuid NULL REFERENCES workflow_runs (id),
  chain_parent_run_id  uuid NULL REFERENCES automation_runs (id),
  chain_depth          integer NOT NULL DEFAULT 0 CHECK (chain_depth BETWEEN 0 AND 16),
  -- GitHub `checkout: event`: the same-repository branch the job checks out instead of the template's base.
  checkout_ref         text NULL CHECK (length(checkout_ref) BETWEEN 1 AND 255),
  triggered_by         uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL,
  started_at           timestamptz NULL,
  finished_at          timestamptz NULL,
  UNIQUE (automation_id, dedup_key)
);
CREATE INDEX automation_runs_automation_idx ON automation_runs (automation_id, created_at DESC);
CREATE INDEX automation_runs_open_idx ON automation_runs (state, created_at) WHERE state IN ('queued', 'starting', 'running');
CREATE INDEX automation_runs_job_idx ON automation_runs (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX automation_runs_workflow_idx ON automation_runs (workflow_run_id) WHERE workflow_run_id IS NOT NULL;

-- Schedules (p5-composer) are replaced, not migrated: nothing used them in production (owner, 2026-10-15).
DROP TABLE job_schedules;

-- Failure notifications (design §11).
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed'));

-- Chat draft kinds: + automation (create/update), automation_change (pause, resume, delete, run now).
ALTER TABLE chat_drafts DROP CONSTRAINT chat_drafts_kind_check;
ALTER TABLE chat_drafts ADD CONSTRAINT chat_drafts_kind_check
  CHECK (kind IN ('job', 'workflow_run', 'worker_config', 'approval_decision', 'job_message', 'machine_task',
                  'tool_install', 'skill', 'automation', 'automation_change'));
