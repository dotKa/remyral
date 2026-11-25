-- p8-cost-efficiency (docs/design/p8-cost-efficiency.md): budgets with billing filter, time zone, notification
-- thresholds and a hard-limit policy; budget overrides; weekly efficiency reports. Additive: existing budgets keep
-- their behaviour (all usage, UTC windows, 80/100 % alerts, pause new jobs at 100 %).
-- Migration number 0068: renumber at merge if a parallel change took it.

-- Which usage a budget counts: all, API-billed only (not local-login) or subscription only (local-login).
ALTER TABLE usage_budgets
  ADD COLUMN billing     text NOT NULL DEFAULT 'all' CHECK (billing IN ('all', 'api', 'subscription')),
  -- IANA zone of the calendar window (validated by the master; length-capped here).
  ADD COLUMN time_zone   text NOT NULL DEFAULT 'UTC'
    CHECK (time_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'),
  -- Notification thresholds in percent of the limit, ascending, 1–5 entries of 1..100.
  ADD COLUMN thresholds  integer[] NOT NULL DEFAULT '{80,100}'
    CHECK (cardinality(thresholds) BETWEEN 1 AND 5 AND 1 <= ALL (thresholds) AND 100 >= ALL (thresholds)),
  -- At 100 %: warn only | pause new jobs in scope | hold only automation-started jobs (and skip automation runs).
  ADD COLUMN on_exceeded text NOT NULL DEFAULT 'pause_new'
    CHECK (on_exceeded IN ('warn', 'pause_new', 'block_automations')),
  -- A dollar budget over subscription runs is meaningless (no per-run dollars, ADR-0014).
  ADD CONSTRAINT usage_budgets_subscription_metric CHECK (NOT (billing = 'subscription' AND metric = 'cost_usd'));

-- Threshold alerts per percent. Rows written before p8 keep threshold_pct NULL (their level is warning/exceeded,
-- unique per level); new rows carry the percent (unique per percent) and level notice|warning|exceeded.
ALTER TABLE usage_budget_alerts ADD COLUMN threshold_pct integer NULL CHECK (threshold_pct BETWEEN 1 AND 100);
ALTER TABLE usage_budget_alerts DROP CONSTRAINT usage_budget_alerts_pkey;
ALTER TABLE usage_budget_alerts DROP CONSTRAINT usage_budget_alerts_level_check;
ALTER TABLE usage_budget_alerts ADD CONSTRAINT usage_budget_alerts_level_check
  CHECK (level IN ('notice', 'warning', 'exceeded'));
CREATE UNIQUE INDEX usage_budget_alerts_legacy_key ON usage_budget_alerts (budget_id, budget_version, window_start, level)
  WHERE threshold_pct IS NULL;
CREATE UNIQUE INDEX usage_budget_alerts_pct_key ON usage_budget_alerts (budget_id, budget_version, window_start, threshold_pct)
  WHERE threshold_pct IS NOT NULL;

-- An owner/admin lets work through an exhausted budget (step-up, audited): for the whole current window (job_id
-- NULL) or for one job. Valid until expires_at, never beyond the window it was granted in. Only revocation (once)
-- may change a row; no DELETE.
CREATE TABLE usage_budget_overrides (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id      uuid NOT NULL REFERENCES usage_budgets (id),
  budget_version integer NOT NULL CHECK (budget_version >= 1),
  window_start   timestamptz NOT NULL,
  job_id         uuid NULL REFERENCES jobs (id),
  expires_at     timestamptz NOT NULL,
  reason         text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_by     uuid NOT NULL REFERENCES users (id),
  created_at     timestamptz NOT NULL,
  revoked_at     timestamptz NULL,
  revoked_by     uuid NULL REFERENCES users (id),
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX usage_budget_overrides_budget_idx ON usage_budget_overrides (budget_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE FUNCTION usage_budget_overrides_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'usage_budget_overrides rows cannot be removed (% rejected)', TG_OP USING ERRCODE = 'RA000';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR (NEW.id, NEW.budget_id, NEW.budget_version, NEW.window_start, NEW.job_id, NEW.expires_at, NEW.reason,
         NEW.created_by, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.budget_id, OLD.budget_version, OLD.window_start, OLD.job_id, OLD.expires_at, OLD.reason,
         OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'budget override % can only be revoked, once', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER usage_budget_overrides_guard
  BEFORE UPDATE OR DELETE ON usage_budget_overrides
  FOR EACH ROW EXECUTE FUNCTION usage_budget_overrides_guard();
CREATE TRIGGER usage_budget_overrides_no_truncate
  BEFORE TRUNCATE ON usage_budget_overrides
  FOR EACH STATEMENT EXECUTE FUNCTION usage_reject_change();

-- Per-user report settings. No row = defaults: UTC, weekly report on for owners/admins, off for others, no chat.
CREATE TABLE user_report_settings (
  user_id         uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  time_zone       text NOT NULL CHECK (time_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'),
  weekly_enabled  boolean NOT NULL,
  -- One of the user's own chat threads (checked by the master on save and again on every post).
  chat_thread_id  uuid NULL REFERENCES chat_threads (id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL
);

-- One weekly report per user and week (the week in the user's zone at generation time). The content is built by
-- deterministic rules from stored facts (identifiers, codes, numbers, display names) — never free text a runtime,
-- repository or worker supplied.
CREATE TABLE efficiency_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT 'weekly' CHECK (kind IN ('weekly')),
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  time_zone     text NOT NULL CHECK (time_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'),
  content       jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 524288),
  -- Where it went: {notification: bool, chatThreadId: uuid|null}.
  delivery      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(delivery) = 'object'),
  generated_at  timestamptz NOT NULL,
  CHECK (period_end > period_start),
  UNIQUE (user_id, kind, period_start)
);
CREATE INDEX efficiency_reports_user_idx ON efficiency_reports (user_id, period_start DESC);

-- Console notifications: a budget's hard limit took effect (jobs paused / automations blocked); the weekly report.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed', 'deploy.succeeded', 'chat.watch', 'chat.note',
                  'monitor.down', 'monitor.up', 'budget.paused', 'report.weekly'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check
  CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed', 'worker.offline',
                  'budget.threshold', 'worker.pending', 'alert', 'worker.config', 'vault.credential',
                  'project.execution', 'automation.failed', 'automation.waiting', 'deploy.waiting',
                  'deploy.failed', 'deploy.succeeded', 'chat.watch', 'chat.note',
                  'monitor.down', 'monitor.up', 'budget.paused', 'report.weekly'));
