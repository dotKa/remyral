-- p5-machine-admin (ADR-0021, docs/design/p5-machine-admin.md): AI machine administration, the tool inventory and
-- recipes, per-machine memory, global and chat-authored (panel-signed) skills.
--
--  * projects `machines`: the built-in workspace project every machine-admin job belongs to (host execution allowed;
--    auto-approve stays off until an admin enables it in Projects → Execution policy).
--  * machine_admin_commands: one row per elevated command a machine-admin job asked for — the exact operation and
--    its digest, the decision (auto-approved / approval / denied), the signed grant time and the redacted result.
--  * workers.tool_inventory / machine_admin: the worker's last CAPABILITIES.toolInventory and .machineAdmin.
--  * approval_requests.action: + machine.admin (platform rule: admin + step-up, never below that floor).
--  * worker_config_versions.cause: + machine_admin (the owner-only switch), + skills_key (the panel skills key
--    delivered in the managed configuration changed).
--  * worker_ops.kind: + tools.detect, tool.install, tool.remove, machine.inspect.
--  * chat_drafts.kind: + machine_task, tool_install, skill.
--  * context_documents namespace: + machine:<workerId> (memory written only by the machine-admin service).
--  * skill_versions.signer (offline / panel); skill_assignments.project may be '*' (all projects).

INSERT INTO projects (id, name, kind, host_execution, created_at)
  VALUES ('machines', 'Machines', 'workspace', true, now())
  ON CONFLICT (id) DO NOTHING;
INSERT INTO project_workspaces (project, egress, updated_at)
  SELECT 'machines', 'web', now() FROM projects WHERE id = 'machines' AND kind = 'workspace'
  ON CONFLICT (project) DO NOTHING;

CREATE TABLE machine_admin_commands (
  request_id      uuid PRIMARY KEY,
  job_id          uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  attempt_id      uuid NOT NULL,
  epoch           integer NOT NULL CHECK (epoch >= 0),
  worker_id       text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  kind            text NOT NULL CHECK (kind IN ('exec', 'write_file', 'read_file')),
  -- The exact operation (write_file content replaced by its size and SHA-256) and the digest the grant covers.
  op              jsonb NOT NULL CHECK (jsonb_typeof(op) = 'object'),
  op_digest       text NOT NULL CHECK (op_digest ~ '^[a-f0-9]{64}$'),
  summary         text NOT NULL CHECK (length(summary) <= 700),
  state           text NOT NULL CHECK (state IN ('requested', 'pending', 'granted', 'denied', 'succeeded',
                                                  'failed', 'refused')),
  auto_approved   boolean NOT NULL DEFAULT false,
  approval_id     uuid NULL,
  reason          text NULL CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,64}$'),
  granted_at      timestamptz NULL,
  exit_code       integer NULL,
  duration_ms     integer NULL CHECK (duration_ms IS NULL OR duration_ms >= 0),
  -- Redacted on the worker and again here; bounded by the protocol (16 KiB).
  output          text NULL CHECK (output IS NULL OR length(output) <= 16384),
  truncated       boolean NOT NULL DEFAULT false,
  file            jsonb NULL CHECK (file IS NULL OR jsonb_typeof(file) = 'object'),
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);
CREATE INDEX machine_admin_commands_worker_idx ON machine_admin_commands (worker_id, created_at DESC);
CREATE INDEX machine_admin_commands_job_idx ON machine_admin_commands (job_id, created_at);

ALTER TABLE workers
  ADD COLUMN tool_inventory jsonb NULL CHECK (tool_inventory IS NULL OR jsonb_typeof(tool_inventory) = 'object'),
  ADD COLUMN tool_inventory_at timestamptz NULL,
  ADD COLUMN machine_admin jsonb NULL CHECK (machine_admin IS NULL OR jsonb_typeof(machine_admin) = 'object'),
  ADD COLUMN machine_admin_at timestamptz NULL;

ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_action_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_action_check
  CHECK (action IN ('git.push_protected', 'git.merge', 'git.force_push', 'deploy', 'fs.delete_outside_workspace',
                    'network.egress_non_allowlisted', 'secret.read', 'runtime.dangerous_tool',
                    'job.budget_increase', 'machine.admin'));

ALTER TABLE worker_config_versions DROP CONSTRAINT worker_config_versions_cause_check;
ALTER TABLE worker_config_versions ADD CONSTRAINT worker_config_versions_cause_check
  CHECK (cause IN ('edit', 'bulk', 'project', 'rollback', 'adopt', 'repository', 'catalog', 'workspace',
                   'unconfined', 'login', 'machine_admin', 'skills_key'));

ALTER TABLE worker_ops DROP CONSTRAINT worker_ops_kind_check;
ALTER TABLE worker_ops ADD CONSTRAINT worker_ops_kind_check
  CHECK (kind IN ('runtime.install', 'runtime.remove', 'runtime.restart', 'login.start', 'login.input',
                  'login.status', 'login.logout', 'ops.cancel', 'service.restart', 'logs.tail', 'diagnostics.run',
                  'sandbox.prepare', 'tools.detect', 'tool.install', 'tool.remove', 'machine.inspect'));

ALTER TABLE chat_drafts DROP CONSTRAINT chat_drafts_kind_check;
ALTER TABLE chat_drafts ADD CONSTRAINT chat_drafts_kind_check
  CHECK (kind IN ('job', 'workflow_run', 'worker_config', 'approval_decision', 'job_message', 'machine_task',
                  'tool_install', 'skill'));

-- Per-machine memory: `machine:<workerId>` documents (kind memory, admin-written, never in a project bundle).
ALTER TABLE context_documents DROP CONSTRAINT context_documents_namespace_check;
ALTER TABLE context_documents ADD CONSTRAINT context_documents_namespace_check
  CHECK (namespace = 'global' OR namespace ~ '^project:[A-Za-z0-9_.:-]{1,128}$'
         OR namespace ~ '^skill:[a-z0-9]+(-[a-z0-9]+)*$' AND length(namespace) <= 70
         OR namespace ~ '^machine:[A-Za-z0-9_.:-]{1,128}$');
ALTER TABLE context_documents ADD CONSTRAINT context_documents_machine_shape
  CHECK (namespace NOT LIKE 'machine:%' OR (kind = 'memory' AND write_role IN ('admin', 'owner')));
ALTER TABLE context_deletion_receipts DROP CONSTRAINT context_deletion_receipts_namespace_check;
ALTER TABLE context_deletion_receipts ADD CONSTRAINT context_deletion_receipts_namespace_check
  CHECK (namespace = 'global' OR namespace ~ '^project:[A-Za-z0-9_.:-]{1,128}$'
         OR namespace ~ '^skill:[a-z0-9]+(-[a-z0-9]+)*$' AND length(namespace) <= 70
         OR namespace ~ '^machine:[A-Za-z0-9_.:-]{1,128}$');

-- Which key signed a skill version (existing rows were all signed with the offline key).
ALTER TABLE skill_versions ADD COLUMN signer text NOT NULL DEFAULT 'offline' CHECK (signer IN ('offline', 'panel'));

-- Assignment to every project: project '*'.
ALTER TABLE skill_assignments DROP CONSTRAINT skill_assignments_project_check;
ALTER TABLE skill_assignments ADD CONSTRAINT skill_assignments_project_check
  CHECK (project = '*' OR project ~ '^[A-Za-z0-9_.:-]{1,128}$');
