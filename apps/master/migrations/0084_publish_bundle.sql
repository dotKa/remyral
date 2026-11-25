-- p10-publish-bundle (ADR-0038, docs/design/p10-publish-bundle.md): one pre-approved chain "create the Pages project
-- if missing → deploy → attach a custom domain → write its CNAME" as the ops action kind pages.publish; deploy on
-- success may carry it; a job's agent may request it (recorded on the job, approved when the job has succeeded).

-- Ops action kinds: + pages.publish (the bundle; its steps are ordinary child actions with source.publishBundle).
ALTER TABLE ops_actions DROP CONSTRAINT ops_actions_kind_check;
ALTER TABLE ops_actions ADD CONSTRAINT ops_actions_kind_check
  CHECK (kind IN ('coolify.deploy', 'coolify.restart', 'coolify.rollback', 'pages.deploy', 'pages.rollback',
                  'dns.upsert', 'dns.delete', 'pages.create_project', 'pages.add_domain',
                  'tunnel.open', 'tunnel.close', 'tunnel.extend', 'pages.publish'));
-- The children of a bundle (looked up by the chain executor and the detail page).
CREATE INDEX ops_actions_publish_bundle_idx ON ops_actions ((source->>'publishBundle'))
  WHERE source ? 'publishBundle';

-- Deploy on success: the publish extras {pagesProject, createIfMissing, domain, dns} (null = a plain Pages / Coolify
-- deploy as before); covers 'none' = requested by the job's agent (publish_site tool) — no pre-approval, the policy
-- decides when the job has succeeded; via 'job' for those.
ALTER TABLE job_deploy_on_success ADD COLUMN publish jsonb NULL
  CHECK (publish IS NULL OR jsonb_typeof(publish) = 'object');
ALTER TABLE job_deploy_on_success DROP CONSTRAINT job_deploy_on_success_covers_check;
ALTER TABLE job_deploy_on_success ADD CONSTRAINT job_deploy_on_success_covers_check
  CHECK (covers IN ('none', 'auto', 'approval', 'approval_step_up'));
ALTER TABLE job_deploy_on_success DROP CONSTRAINT job_deploy_on_success_via_check;
ALTER TABLE job_deploy_on_success ADD CONSTRAINT job_deploy_on_success_via_check
  CHECK (via IN ('api', 'chat', 'automation', 'job'));
