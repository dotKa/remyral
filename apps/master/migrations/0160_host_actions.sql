-- p17-host-actions (docs/design/p17-host-actions.md, ADR-0063 amendment 2026-10-26): requests the console signs for the
-- remyral-ctl host applier besides the domain change (console_domain_requests, 0151) — control-plane upgrade and
-- rollback (part 2), backups (part 3). The master writes `<data>/host/requests/<kind>.json` (+ signature); the host's
-- result file moves the state. At most one open request of any kind at a time (the host runs them one by one).
--
-- `params`: the request's non-secret fields as the owner chose them (shown in the console and the audit trail). A
-- secret a request carries to the host (the off-site keys, part 3) is never stored here — it lives sealed in its own
-- setting and is only written into the request file.
-- States: pending (written, not picked up) → applying → applied | rolled_back | held | failed; refused (the host
-- rejected it), expired (nobody picked it up in time), cancelled (the owner withdrew it while pending).
CREATE TABLE host_action_requests (
  id            uuid PRIMARY KEY,
  kind          text NOT NULL CHECK (kind ~ '^[a-z][a-z-]{1,31}$'),
  params        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object'),
  nonce         text NOT NULL UNIQUE CHECK (nonce ~ '^[0-9a-f]{32}$'),
  state         text NOT NULL CHECK (
    state IN ('pending', 'applying', 'applied', 'rolled_back', 'held', 'failed', 'refused', 'expired', 'cancelled')
  ),
  step          text NULL CHECK (step IS NULL OR char_length(step) <= 200),
  detail        text NULL CHECK (detail IS NULL OR char_length(detail) <= 500),
  -- The tail of the host's output for this request (no line naming a secret; the host filters, the master re-checks).
  log           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(log) = 'array'),
  requested_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  requested_at  timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL CHECK (expires_at > requested_at),
  updated_at    timestamptz NOT NULL,
  finished_at   timestamptz NULL
);

CREATE UNIQUE INDEX host_action_requests_one_open ON host_action_requests ((true))
  WHERE state IN ('pending', 'applying');
CREATE INDEX host_action_requests_recent ON host_action_requests (kind, requested_at DESC);
