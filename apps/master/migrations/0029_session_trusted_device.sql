-- p5-stepup-window (ADR-0009 amendment 2026-10-14, docs/design/p5-remember-device.md §8): a session
-- established on a trusted device remembers which one. Remember-me and trusted-device sessions keep one
-- TOTP step-up for the rest of the session; revoking (deleting) the device clears the reference, so the
-- session falls back to the standard step-up window at once. Existing rows: NULL (standard behaviour).
ALTER TABLE sessions
  ADD COLUMN trusted_device_id uuid NULL REFERENCES trusted_devices (id) ON DELETE SET NULL;

CREATE INDEX sessions_trusted_device_idx ON sessions (trusted_device_id) WHERE trusted_device_id IS NOT NULL;
