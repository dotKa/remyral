-- p5-self-password (ADR-0009 §3/§8, docs/design/p5-rbac.md "residual risks"): self-service password change
-- and the forced change for accounts created with a temporary password.
--
-- `password_change_required` is set for accounts an owner created with a generated temporary password
-- (POST /users). After the second factor such an account gets a `password_change` session: the only
-- reachable route is POST /auth/password/initial, and a full session is issued only after a new password
-- was set.

ALTER TABLE users
  ADD COLUMN password_change_required boolean NOT NULL DEFAULT false,
  ADD COLUMN password_changed_at      timestamptz NULL;

ALTER TABLE sessions DROP CONSTRAINT sessions_stage_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_stage_check CHECK (stage IN ('mfa_pending', 'enrollment', 'password_change', 'full'));

-- Accounts created through the user API (created_by set) that never signed in still hold the temporary
-- password they were handed: require the change at their first login. Accounts that already signed in
-- are not flagged (whether they still use the temporary password is unknowable); they can change it from
-- Settings → Account.
UPDATE users SET password_change_required = true WHERE created_by IS NOT NULL AND last_login_at IS NULL;

---------------------------------------------------------------------------------------------------
-- p5-notifications (docs/design/p5-notifications.md): in-app notifications, per-user preferences and
-- channel targets, the delivery queue for outbound channels (e-mail, webhook) and the producer's cursor
-- over the shared `outbox`.
---------------------------------------------------------------------------------------------------

CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed',
                                             'worker.offline', 'budget.threshold', 'worker.pending')),
  severity     text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  -- Built from identifiers and enumerations only, then passed through the secret redactor; never secrets.
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body         text NOT NULL CHECK (length(body) <= 2000),
  -- Console-relative path only (no scheme/host, not protocol-relative): the UI navigates within the app.
  link         text NULL CHECK (link IS NULL OR (length(link) <= 501 AND link ~ '^/[A-Za-z0-9/_.:=?&%-]*$' AND link !~ '^//')),
  -- One notification per recipient and event (producers are at-least-once; this makes them idempotent).
  dedupe_key   text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 300),
  created_at   timestamptz NOT NULL,
  read_at      timestamptz NULL,
  UNIQUE (recipient_id, dedupe_key)
);

CREATE INDEX notifications_recipient_idx ON notifications (recipient_id, created_at DESC, id DESC);
CREATE INDEX notifications_unread_idx ON notifications (recipient_id) WHERE read_at IS NULL;

-- Opt-in per kind × outbound channel (in-app is always on and has no row).
CREATE TABLE notification_preferences (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('approval.requested', 'approval.expiring', 'job.failed',
                                           'worker.offline', 'budget.threshold', 'worker.pending')),
  channel    text NOT NULL CHECK (channel IN ('email', 'webhook')),
  enabled    boolean NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, kind, channel)
);

-- Where a user's outbound notifications go. Not secret, but personal: never logged, only flags audited.
CREATE TABLE notification_targets (
  user_id     uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  email       text NULL CHECK (email IS NULL OR (length(email) <= 254 AND email ~ '^[^@\s<>",;]+@[^@\s<>",;]+$')),
  webhook_url text NULL CHECK (webhook_url IS NULL OR (length(webhook_url) <= 2000 AND webhook_url ~ '^https?://')),
  updated_at  timestamptz NOT NULL
);

-- Delivery queue for outbound channels (dedicated outbox: the shared `outbox` belongs to the dispatcher).
-- pending → sent, or → dead after the last retry / a permanent error (dead letter, kept for inspection).
CREATE TABLE notification_deliveries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('email', 'webhook')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dead')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL,
  -- Error code only (e.g. `smtp_transient`, `http_503`); never a server response text or a target.
  last_error      text NULL CHECK (last_error IS NULL OR last_error ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at      timestamptz NOT NULL,
  sent_at         timestamptz NULL,
  dead_at         timestamptz NULL,
  UNIQUE (notification_id, channel),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CHECK ((status = 'dead') = (dead_at IS NOT NULL))
);

CREATE INDEX notification_deliveries_due_idx ON notification_deliveries (next_attempt_at) WHERE status = 'pending';

-- Producer cursor over the shared `outbox` (read-only there: `dispatched_at` stays the dispatcher's).
-- Rows above `floor_id` are processed once each (`notification_outbox_seen`); the floor only advances
-- over rows older than a settle window, so a transaction that commits late is not skipped.
CREATE TABLE notification_consumer (
  name     text PRIMARY KEY,
  floor_id bigint NOT NULL CHECK (floor_id >= 0)
);

CREATE TABLE notification_outbox_seen (
  outbox_id bigint PRIMARY KEY
);

-- Start after the existing history: no notification storm for events that happened before this release.
INSERT INTO notification_consumer (name, floor_id) VALUES ('outbox', COALESCE((SELECT max(id) FROM outbox), 0));
