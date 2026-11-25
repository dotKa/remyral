-- p6-alerts (docs/design/p6-observability.md §6): operational alarms evaluated by the master.
-- 1. A new notification kind `alert` (in-app always; e-mail/webhook opt-in like every other kind).
-- 2. alert_states: one row per (rule, instance) with the current status and the episode counter that
--    makes notifications idempotent (dedupe key alert:<rule>:<instance>:<episode>:<event>).

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert'));

ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert'));

CREATE TABLE alert_states (
  -- Closed rule catalog (apps/master/src/alerts/rules.ts).
  rule              text NOT NULL CHECK (rule IN ('worker.offline_with_work', 'queue.backlog',
                                                  'jobs.failure_spike', 'budget.threshold')),
  -- Identifier of the alerting subject: a worker id, a budget id or 'global'. Never free text.
  instance          text NOT NULL CHECK (instance ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  status            text NOT NULL CHECK (status IN ('firing', 'resolved')),
  severity          text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  -- Incremented when a resolved alert fires again after the cooldown (a new notification episode).
  episode           integer NOT NULL DEFAULT 1 CHECK (episode >= 1),
  fired_at          timestamptz NOT NULL,
  resolved_at       timestamptz NULL,
  last_evaluated_at timestamptz NOT NULL,
  -- Numbers and identifiers only (counts, ages, ratios); shown in the notification body.
  details           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  PRIMARY KEY (rule, instance),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);

CREATE INDEX alert_states_firing_idx ON alert_states (rule) WHERE status = 'firing';
