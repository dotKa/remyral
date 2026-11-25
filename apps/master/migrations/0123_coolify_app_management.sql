-- p15-coolify-create (ADR-0057, docs/design/p15-coolify-create.md): create Coolify applications, edit their
-- environment variables and domains from Remana (owner request 2026-10-21: "deploy work without ever opening Coolify").
--  * coolify_connections.manage_apps: the administrator allowed this connection to create / change applications
--    (its token then needs Coolify's `write` ability). A column, not a key in `config`, so a master rolled back to
--    before this migration still parses every connection's strict settings. Default off: nothing changes for existing
--    connections until an administrator turns it on (Ayarlar → Entegrasyonlar → Coolify, always-fresh code).
--  * coolify_app_creations: one row per "new application" request — idempotency (one creation per project + key, a
--    retried request answers with the same row) and history. Non-secret fields only: environment variable keys and
--    sources, never a value (secret values go master → Coolify in the same request and are never stored).
--  * chat_drafts.kind: + coolify_change (the assistant's coolify_create_app / coolify_set_env / coolify_set_domains).
--
-- Rollback: the old master ignores the column and the table; drop them by hand only after a rollback is final
--   ALTER TABLE coolify_connections DROP COLUMN manage_apps; DROP TABLE coolify_app_creations;

ALTER TABLE coolify_connections ADD COLUMN manage_apps boolean NOT NULL DEFAULT false;

CREATE TABLE coolify_app_creations (
  id               uuid PRIMARY KEY,
  project          text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  connection_id    uuid NULL REFERENCES coolify_connections (id) ON DELETE SET NULL,
  idempotency_key  text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  env              text NOT NULL CHECK (env IN ('preview', 'production')),
  -- What was asked (validated by zod: CoolifyCreateAppInput minus values), for history and the retry answer.
  request          jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  state            text NOT NULL CHECK (state IN ('creating', 'created', 'failed')),
  app_uuid         text NULL CHECK (app_uuid IS NULL OR app_uuid ~ '^[A-Za-z0-9]{6,64}$'),
  -- {linked, envs: {created, failed}, deployActionId, warnings[]} — no values.
  result           jsonb NULL CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  error            text NULL CHECK (error IS NULL OR length(error) <= 1000),
  created_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  via              text NOT NULL CHECK (via IN ('api', 'chat')),
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  UNIQUE (project, idempotency_key)
);
CREATE INDEX coolify_app_creations_project ON coolify_app_creations (project, created_at DESC);

-- Chat draft kind `coolify_change`, appended to whatever the constraint allows now (same helper as 0118).
CREATE FUNCTION pg_temp.widen_check_0123(t text, c text, col text, extra text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  def text;
  vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = c AND conrelid = t::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint % not found', c;
  END IF;
  IF def ~ '\{' THEN
    vals := string_to_array(substring(def from '\{([^}]*)\}'), ',');
  ELSE
    SELECT array_agg(DISTINCT m[1]) INTO vals FROM regexp_matches(def, '''([A-Za-z0-9_.:-]+)''', 'g') AS m;
  END IF;
  IF coalesce(array_length(vals, 1), 0) < 2 THEN
    RAISE EXCEPTION 'could not read the values of %', c;
  END IF;
  vals := vals || extra;
  SELECT array_agg(DISTINCT v ORDER BY v) INTO vals FROM unnest(vals) AS v;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I = ANY (%L::text[]))', t, c, col, vals);
END
$$;

SELECT pg_temp.widen_check_0123('chat_drafts', 'chat_drafts_kind_check', 'kind', ARRAY['coolify_change']);
