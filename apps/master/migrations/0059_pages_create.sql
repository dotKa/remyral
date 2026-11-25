-- p6-pages-create: ops actions that create (or adopt) a Cloudflare Pages project and attach a custom domain to a
-- project's Pages target. Additive: the kind CHECK gains two values; existing rows are unchanged.
ALTER TABLE ops_actions DROP CONSTRAINT ops_actions_kind_check;
ALTER TABLE ops_actions ADD CONSTRAINT ops_actions_kind_check
  CHECK (kind IN ('coolify.deploy', 'coolify.restart', 'coolify.rollback', 'pages.deploy', 'pages.rollback',
                  'dns.upsert', 'dns.delete', 'pages.create_project', 'pages.add_domain'));
