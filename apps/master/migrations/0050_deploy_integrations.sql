-- p6-deploy-integrations (ADR-0028, docs/design/p6-deploy-integrations.md): the master holds the Coolify and
-- Cloudflare tokens and executes typed "ops actions" (deploy, restart, DNS change, Pages deploy) that humans, the
-- orchestrator chat and (phase 2) automations request. Agents never see a token.

-- Settings → Integrations: one row per provider. The token lives only in `secret` (AES-256-GCM under the HKDF
-- sub-key `ops-integrations` of the master key file, AAD `ops-integration:<provider>`); no other column holds it.
CREATE TABLE ops_integrations (
  provider          text PRIMARY KEY CHECK (provider IN ('coolify', 'cloudflare')),
  -- Non-secret settings: Coolify {url, team, denyResources[]}, Cloudflare {accountId}.
  config            jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  secret            bytea NOT NULL,
  -- SHA-256 prefix of the token (identifies a rotation in the audit log; not the token).
  key_fingerprint   text NOT NULL CHECK (key_fingerprint ~ '^[0-9a-f]{16}$'),
  last_test         jsonb NULL CHECK (last_test IS NULL OR jsonb_typeof(last_test) = 'object'),
  last_test_at      timestamptz NULL,
  updated_by        uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL
);

-- Project → Deploy targets: Coolify resources per environment, Cloudflare Pages project, DNS zones, protected
-- records and the per-project policy (validated by zod: DeployTargets).
CREATE TABLE project_deploy_targets (
  project     text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  config      jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  version     integer NOT NULL CHECK (version >= 1),
  updated_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL
);

-- Ops actions: what was requested, by whom, the policy decision, the diff shown to the approver, the result.
CREATE TABLE ops_actions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project            text NOT NULL REFERENCES projects (id),
  kind               text NOT NULL CHECK (kind IN ('coolify.deploy', 'coolify.restart', 'coolify.rollback',
                                                   'pages.deploy', 'pages.rollback', 'dns.upsert', 'dns.delete')),
  env                text NULL CHECK (env IS NULL OR env IN ('preview', 'production')),
  params             jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  params_hash        text NOT NULL CHECK (params_hash ~ '^[0-9a-f]{64}$'),
  -- Human-readable target and the diff against the current state (computed by the master, never by the caller).
  target             jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object'),
  diff               jsonb NOT NULL CHECK (jsonb_typeof(diff) = 'object'),
  -- Values needed for a rollback (previous DNS record, previous image tag, previous Pages deployment).
  previous           jsonb NULL CHECK (previous IS NULL OR jsonb_typeof(previous) = 'object'),
  policy_decision    text NOT NULL CHECK (policy_decision IN ('auto', 'approval', 'approval_step_up', 'refused')),
  policy_reason      text NOT NULL CHECK (length(policy_reason) BETWEEN 1 AND 500),
  state              text NOT NULL CHECK (state IN ('awaiting_approval', 'refused', 'denied', 'expired', 'executing',
                                                    'deploying', 'succeeded', 'failed')),
  requested_by_type  text NOT NULL CHECK (requested_by_type IN ('user', 'system')),
  requested_by_id    text NOT NULL CHECK (length(requested_by_id) BETWEEN 1 AND 128),
  -- api (REST / console), chat (a confirmed orchestrator draft), automation (phase 2).
  via                text NOT NULL CHECK (via IN ('api', 'chat', 'automation')),
  note               text NULL CHECK (note IS NULL OR length(note) <= 500),
  idempotency_key    text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  rollback_of        uuid NULL REFERENCES ops_actions (id),
  decided_by         uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  decided_at         timestamptz NULL,
  decision_reason    text NULL CHECK (decision_reason IS NULL OR length(decision_reason) <= 500),
  step_up_at         timestamptz NULL,
  result             jsonb NULL CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  error              text NULL CHECK (error IS NULL OR length(error) <= 1000),
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  expires_at         timestamptz NULL,
  finished_at        timestamptz NULL,
  UNIQUE (requested_by_type, requested_by_id, idempotency_key)
);
CREATE INDEX ops_actions_project_idx ON ops_actions (project, created_at DESC);
CREATE INDEX ops_actions_state_idx ON ops_actions (state, created_at DESC);

-- Chat draft kinds: + ops_action (draft_deploy, draft_dns_change).
ALTER TABLE chat_drafts DROP CONSTRAINT chat_drafts_kind_check;
ALTER TABLE chat_drafts ADD CONSTRAINT chat_drafts_kind_check
  CHECK (kind IN ('job', 'workflow_run', 'worker_config', 'approval_decision', 'job_message', 'machine_task',
                  'tool_install', 'skill', 'automation', 'automation_change', 'ops_action'));
