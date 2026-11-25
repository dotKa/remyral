-- p6-automations-next (docs/design/p6-automations.md §18, ADR-0026): webhook secret overlap window, webhook IP
-- allow-list, fork pull request checkout pinned to the event's head SHA, more GitHub events and several events per
-- automation. Cross-project chains need no schema change (chain_source_id already references any automation).
-- Migration number 0045: renumber at merge if a parallel change took it.

-- §18.1: the previous webhook secret stays valid until its expiry after a rotation (sealed like the current one,
-- AAD automation-webhook-previous:<id>). Only webhook automations have one; secret and expiry come together.
ALTER TABLE automations ADD COLUMN webhook_secret_previous bytea NULL;
ALTER TABLE automations ADD COLUMN webhook_secret_previous_hint text NULL
  CHECK (webhook_secret_previous_hint IS NULL OR webhook_secret_previous_hint ~ '^[a-f0-9]{8}$');
ALTER TABLE automations ADD COLUMN webhook_secret_previous_expires_at timestamptz NULL;
ALTER TABLE automations ADD CONSTRAINT automations_webhook_previous_check
  CHECK ((webhook_secret_previous IS NULL) = (webhook_secret_previous_expires_at IS NULL)
     AND (webhook_secret_previous IS NULL) = (webhook_secret_previous_hint IS NULL)
     AND (webhook_secret_previous IS NULL OR trigger_kind = 'webhook'));

-- §18.5: client addresses / CIDRs a webhook accepts calls from (NULL = any).
ALTER TABLE automations ADD COLUMN webhook_allow_ips text[] NULL
  CHECK (webhook_allow_ips IS NULL OR (cardinality(webhook_allow_ips) BETWEEN 1 AND 20 AND trigger_kind = 'webhook'));

-- §18.5: more GitHub events, several per automation. github_event stays the trigger's first event; github_events
-- (every selected event) routes deliveries.
ALTER TABLE automations DROP CONSTRAINT automations_github_event_check;
ALTER TABLE automations ADD CONSTRAINT automations_github_event_check
  CHECK (github_event IS NULL OR github_event IN ('pull_request', 'push', 'issues', 'issue_comment',
                                                  'pull_request_review', 'release', 'workflow_run', 'check_suite'));
ALTER TABLE automations ADD COLUMN github_events text[] NULL;
UPDATE automations SET github_events = ARRAY[github_event] WHERE github_event IS NOT NULL;
ALTER TABLE automations ADD CONSTRAINT automations_github_events_check
  CHECK ((github_event IS NULL) = (github_events IS NULL)
     AND (github_events IS NULL OR (cardinality(github_events) BETWEEN 1 AND 8 AND github_event = github_events[1]
          AND github_events <@ ARRAY['pull_request', 'push', 'issues', 'issue_comment', 'pull_request_review',
                                     'release', 'workflow_run', 'check_suite'])));
DROP INDEX automations_github_idx;
CREATE INDEX automations_github_idx ON automations (github_repo) WHERE state = 'active' AND github_repo IS NOT NULL;

-- §18.2: an untrusted pull request checked out at the event's head SHA (never the fork's URL or branch).
ALTER TABLE automation_runs ADD COLUMN checkout_pull_request integer NULL
  CHECK (checkout_pull_request IS NULL OR checkout_pull_request > 0);
ALTER TABLE automation_runs ADD COLUMN checkout_head_sha text NULL
  CHECK (checkout_head_sha IS NULL OR checkout_head_sha ~ '^[0-9a-f]{40}$');
ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_checkout_pr_check
  CHECK ((checkout_pull_request IS NULL) = (checkout_head_sha IS NULL));
