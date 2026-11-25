-- p16-selfhost-onboarding (docs/design/p16-selfhost-onboarding.md, ADR-0063): the one-time setup token a fresh
-- self-hosted install prints once, and the owners' first-run wizard (organisation name, step progress).

-- A setup token creates the FIRST account (an owner) from the browser instead of a shell. Only its SHA-256 is kept;
-- issuing a new one replaces any unused one; a token is single-use and expires (24 h by default). The routes refuse
-- every token once any account exists.
CREATE TABLE setup_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL CHECK (expires_at > created_at),
  used_at     timestamptz NULL,
  used_by     uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  CHECK (used_by IS NULL OR used_at IS NOT NULL)
);

-- The first-run wizard of a fresh install (one row; shown to owners until completed). `steps` holds the owner's
-- explicit marks per step ({"<step id>": "done" | "skipped"}); facts (an approved machine, a project, a succeeded job)
-- are derived at read time, never stored here.
CREATE TABLE onboarding_state (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  organisation_name  text NULL CHECK (organisation_name IS NULL OR char_length(organisation_name) BETWEEN 1 AND 80),
  steps              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(steps) = 'object'),
  completed_at       timestamptz NULL,
  completed_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL,
  updated_by         uuid NULL REFERENCES users (id) ON DELETE SET NULL
);

-- An existing installation (users already exist when this migration runs) does not need the wizard: it is recorded
-- as completed so owners of a running system never see it. A fresh database gets no row (the wizard shows).
INSERT INTO onboarding_state (id, completed_at, updated_at)
SELECT 1, now(), now()
WHERE EXISTS (SELECT 1 FROM users);
