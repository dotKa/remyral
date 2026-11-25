-- p17-domain-wizard (docs/design/p17-domain-wizard.md, ADR-0063 amendment 2026-10-24): the console's public address as
-- an owner-editable setting, and the domain change requests a remyral-ctl host applies without a terminal.

-- The public origin the master links with (e-mails, install commands, GitHub App callbacks, webhook payload links, the
-- certificate check). One row; absent = the environment's PUBLIC_ORIGIN / NOTIFY_PUBLIC_URL (the previous behaviour).
-- `source`: the owner saved it in the setup wizard, or the host applier confirmed a domain change it applied.
CREATE TABLE console_domain_setting (
  id             smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  public_origin  text NOT NULL CHECK (
    public_origin ~ '^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:[1-9][0-9]{0,4})?$'
    AND char_length(public_origin) <= 270
  ),
  source         text NOT NULL CHECK (source IN ('owner', 'host-applier')),
  updated_at     timestamptz NOT NULL,
  updated_by     uuid NULL REFERENCES users (id) ON DELETE SET NULL
);

-- A domain change for a remyral-ctl install: the master writes a signed request file the host's root-owned applier
-- (`remyral-ctl apply-pending`) picks up; the applier's result file moves the state. At most one open request.
-- States: pending (written, not picked up) → applying → applied | rolled_back | failed; refused (the host rejected it),
-- expired (nobody picked it up in time), cancelled (the owner withdrew it while pending).
CREATE TABLE console_domain_requests (
  id               uuid PRIMARY KEY,
  domain           text NOT NULL CHECK (char_length(domain) BETWEEN 4 AND 253),
  tls_mode         text NOT NULL CHECK (tls_mode IN ('letsencrypt', 'cloudflare', 'proxy')),
  acme_email       text NULL CHECK (acme_email IS NULL OR char_length(acme_email) <= 254),
  previous_domain  text NOT NULL CHECK (char_length(previous_domain) BETWEEN 1 AND 253),
  nonce            text NOT NULL UNIQUE CHECK (nonce ~ '^[0-9a-f]{32}$'),
  state            text NOT NULL CHECK (
    state IN ('pending', 'applying', 'applied', 'rolled_back', 'failed', 'refused', 'expired', 'cancelled')
  ),
  detail           text NULL CHECK (detail IS NULL OR char_length(detail) <= 500),
  requested_by     uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  requested_at     timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL CHECK (expires_at > requested_at),
  updated_at       timestamptz NOT NULL
);

CREATE UNIQUE INDEX console_domain_requests_one_open ON console_domain_requests ((true))
  WHERE state IN ('pending', 'applying');
CREATE INDEX console_domain_requests_recent ON console_domain_requests (requested_at DESC);
