-- p16-api-tokens (docs/design/p16-api-tokens.md, ADR-0058): personal API tokens, service accounts, the token
-- expiry notification. Additive only.
--
--  * users.kind: 'human' (every existing row) or 'service' (a service account: no login, never owner).
--  * users.description: what a service account is for (null for people).
--  * api_tokens: one row per token; only HMAC-SHA256 hashes of the secret (current + the previous one during a
--    rotation overlap) are stored.
--  * notification kind 'api_token.expiring' (7 days before a token expires, once per expiry date).
--
-- Rollback: an older master ignores all of it (tokens then stop working: it never reads Authorization). To remove:
--   DELETE FROM notifications WHERE kind = 'api_token.expiring';
--   DELETE FROM notification_preferences WHERE kind = 'api_token.expiring';
--   DROP TABLE api_tokens;
--   DELETE FROM users WHERE kind = 'service';
--   ALTER TABLE users DROP CONSTRAINT users_service_not_owner, DROP COLUMN kind, DROP COLUMN description;
-- Migration number 0139 (renumbered at merge: 0138 is p16-chat-complete).

ALTER TABLE users
  ADD COLUMN kind text NOT NULL DEFAULT 'human' CHECK (kind IN ('human', 'service')),
  ADD COLUMN description text NULL CHECK (description IS NULL OR char_length(description) <= 500);
ALTER TABLE users ADD CONSTRAINT users_service_not_owner CHECK (kind = 'human' OR role <> 'owner');

CREATE TABLE api_tokens (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL CHECK (kind IN ('personal', 'service')),
  -- The user (personal) or the service account (service) whose rights the token carries.
  principal_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name                  text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  scopes                text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 8),
  -- Step-up events an admin granted with a code at creation (only while the policy allows grants).
  granted_events        text[] NOT NULL DEFAULT '{}' CHECK (cardinality(granted_events) <= 64),
  allowed_cidrs         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(allowed_cidrs) <= 16),
  -- Display only: prefix + first 4 + "…" + last 4 characters.
  hint                  text NOT NULL CHECK (char_length(hint) <= 40),
  -- HMAC-SHA256(HKDF(master key, "remana/api-token/v1"), token).
  secret_hash           bytea NOT NULL UNIQUE CHECK (length(secret_hash) = 32),
  previous_hash         bytea NULL UNIQUE CHECK (previous_hash IS NULL OR length(previous_hash) = 32),
  previous_valid_until  timestamptz NULL,
  expires_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL,
  created_by            uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  rotated_at            timestamptz NULL,
  revoked_at            timestamptz NULL,
  revoked_by            uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  revoke_reason         text NULL CHECK (revoke_reason IS NULL OR revoke_reason ~ '^[a-z_]{1,32}$'),
  last_used_at          timestamptz NULL,
  last_used_ip          text NULL CHECK (last_used_ip IS NULL OR char_length(last_used_ip) <= 64),
  use_count             bigint NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  -- The expiry the 7-day notice was sent for (a rotation with a new expiry sends a new one).
  expiry_notified_for   timestamptz NULL,
  CHECK ((previous_hash IS NULL) = (previous_valid_until IS NULL)),
  CHECK (expires_at > created_at)
);
CREATE INDEX api_tokens_principal ON api_tokens (principal_id, created_at DESC);
CREATE INDEX api_tokens_expiring ON api_tokens (expires_at) WHERE revoked_at IS NULL;

-- Notification kind 'api_token.expiring': appended to whatever the constraints allow now (see 0136).
DO $$
DECLARE
  t text;
  c text;
  def text;
  kinds text[];
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_preferences'] LOOP
    c := t || '_kind_check';
    SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
     WHERE conname = c AND conrelid = t::regclass;
    IF def IS NULL THEN
      RAISE EXCEPTION 'constraint % not found', c;
    END IF;
    IF def ~ '\{' THEN
      kinds := string_to_array(substring(def from '\{([^}]*)\}'), ',');
    ELSE
      SELECT array_agg(DISTINCT m[1]) INTO kinds FROM regexp_matches(def, '''([a-z0-9_.]+)''', 'g') AS m;
    END IF;
    IF coalesce(array_length(kinds, 1), 0) < 2 THEN
      RAISE EXCEPTION 'could not read the kinds of %', c;
    END IF;
    kinds := kinds || ARRAY['api_token.expiring'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, c, kinds);
  END LOOP;
END;
$$;
