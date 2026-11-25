-- p8-pwa (docs/design/p8-pwa.md): Web Push as a third outbound notification channel. Additive: the channel
-- CHECKs gain 'push'; existing rows are unchanged.
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_channel_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_channel_check
  CHECK (channel IN ('email', 'webhook', 'push'));
ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_channel_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_channel_check
  CHECK (channel IN ('email', 'webhook', 'push'));

-- One row per browser push subscription (one installed PWA / browser profile). The endpoint is the push
-- service URL the browser handed out; its keys (p256dh + auth) are sealed with a master sub-key
-- (AES-256-GCM, AAD bound to the row id), never stored in clear. Removed when the user revokes it, when
-- every session of the user is revoked (log out everywhere, password change, reset, disable, role
-- elevation — sessions.deleteAllForUser), when the trusted device it was registered from is revoked, when
-- the push service answers 404/410, and when the browser has not re-registered it for 30 days.
CREATE TABLE push_subscriptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint          text NOT NULL UNIQUE CHECK (length(endpoint) BETWEEN 9 AND 2000),
  keys_sealed       bytea NOT NULL CHECK (length(keys_sealed) BETWEEN 30 AND 512),
  -- Coarse "browser on OS" label (trusted-devices.ts deviceLabel), never the full user agent.
  label             text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  trusted_device_id uuid NULL REFERENCES trusted_devices (id) ON DELETE CASCADE,
  created_ip        text NULL CHECK (created_ip IS NULL OR length(created_ip) <= 64),
  created_at        timestamptz NOT NULL,
  last_seen_at      timestamptz NOT NULL,
  last_success_at   timestamptz NULL,
  -- Consecutive rejected deliveries (400/401/403 from the push service); three remove the row.
  failures          integer NOT NULL DEFAULT 0 CHECK (failures >= 0)
);

CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id, last_seen_at DESC);
CREATE INDEX push_subscriptions_device_idx ON push_subscriptions (trusted_device_id)
  WHERE trusted_device_id IS NOT NULL;
