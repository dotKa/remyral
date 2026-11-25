-- p5-sandbox-ops (ADR-0019, docs/design/p5-sandbox-ops.md): sandbox status and preparation from the panel, the
-- opt-in `unconfined` profile, and login -> auth.
--
--  * projects.unconfined_execution: the project allows jobs with sandboxProfile "unconfined" (ADR-0019); only on
--    workers whose panel configuration has allowUnconfined. Changed with admin + always-fresh step-up, audited.
--  * workers.sandbox_status: the worker's last CAPABILITIES.sandboxStatus (per-profile readiness with codes and
--    fixes, host checks) for the Fleet "Sandbox" card.
--  * worker_ops.kind: + sandbox.prepare.
--  * worker_config_versions.cause: + unconfined (the dedicated allowUnconfined route), + login (a successful
--    subscription login set the runtime's auth to local-login).

ALTER TABLE projects ADD COLUMN unconfined_execution boolean NOT NULL DEFAULT false;

ALTER TABLE workers
  ADD COLUMN sandbox_status jsonb NULL CHECK (sandbox_status IS NULL OR jsonb_typeof(sandbox_status) = 'object'),
  ADD COLUMN sandbox_status_at timestamptz NULL;

ALTER TABLE worker_ops DROP CONSTRAINT worker_ops_kind_check;
ALTER TABLE worker_ops ADD CONSTRAINT worker_ops_kind_check
  CHECK (kind IN ('runtime.install', 'runtime.remove', 'runtime.restart', 'login.start', 'login.input',
                  'login.status', 'login.logout', 'ops.cancel', 'service.restart', 'logs.tail', 'diagnostics.run',
                  'sandbox.prepare'));

ALTER TABLE worker_config_versions DROP CONSTRAINT worker_config_versions_cause_check;
ALTER TABLE worker_config_versions ADD CONSTRAINT worker_config_versions_cause_check
  CHECK (cause IN ('edit', 'bulk', 'project', 'rollback', 'adopt', 'repository', 'catalog', 'workspace',
                   'unconfined', 'login'));
