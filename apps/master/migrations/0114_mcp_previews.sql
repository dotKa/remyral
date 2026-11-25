-- p14-mcp-chat (ADR-0054 P5, docs/design/p14-mcp-skills.md §4, §15): MCP install previews (chat `propose_mcp_install`
-- cards and Yetenekler → Keşfet) and the chat draft kind `mcp_install`. A preview is what the MASTER resolved from a
-- registry / npm / PyPI / URL reference (exact version + integrity, secret slots, hosts, warnings) — never the
-- assistant's text. Nothing is signed or installed until an admin confirms it with a fresh authenticator code; the
-- confirmation publishes the spec, starts the canary-first install and (once the canary reports it) probes the tools.
-- Additive only (rollback: leave the table; older code never reads it). Migration number 0114 (given in the brief);
-- renumber at merge if needed.

CREATE TABLE mcp_previews (
  id               uuid PRIMARY KEY,
  source_kind      text NOT NULL CHECK (source_kind IN ('registry', 'npm', 'pypi', 'url')),
  -- The reference as asked for ({ref, version?}); never a credential.
  source           jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object' AND octet_length(source::text) <= 4096),
  -- The resolved proposal (publish body, warnings, findings, suggested hosts). Bounded like a spec plus its notes.
  proposal         jsonb NOT NULL CHECK (jsonb_typeof(proposal) = 'object' AND octet_length(proposal::text) <= 65536),
  proposal_sha256  text NOT NULL CHECK (proposal_sha256 ~ '^[0-9a-f]{64}$'),
  via              text NOT NULL CHECK (via IN ('chat', 'panel')),
  state            text NOT NULL CHECK (state IN ('previewed', 'published', 'discarded', 'expired')),
  created_by       uuid NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL CHECK (expires_at > created_at),
  -- Set by the confirmation.
  published_by     uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  published_at     timestamptz NULL,
  server_id        text NULL CHECK (server_id IS NULL OR server_id ~ '^[a-z][a-z0-9-]{1,31}$'),
  version          text NULL CHECK (version IS NULL OR length(version) <= 64),
  project          text NULL CHECK (project IS NULL OR project ~ '^(\*|[A-Za-z0-9_.:-]{1,128})$'),
  action_id        uuid NULL,
  -- Tool discovery after the install: the remote op that probed it ('' = claimed, op not created yet), why not.
  auto_probe       boolean NOT NULL DEFAULT false,
  probe_op_id      text NULL CHECK (probe_op_id IS NULL OR length(probe_op_id) <= 64),
  probe_skipped    text NULL CHECK (probe_skipped IS NULL OR length(probe_skipped) <= 120),
  CHECK (state <> 'published' OR (server_id IS NOT NULL AND version IS NOT NULL AND published_at IS NOT NULL))
);
CREATE INDEX mcp_previews_user_idx ON mcp_previews (created_by, state, created_at DESC);
CREATE INDEX mcp_previews_expiry_idx ON mcp_previews (expires_at) WHERE state = 'previewed';
CREATE INDEX mcp_previews_probe_idx ON mcp_previews (server_id, version) WHERE state = 'published' AND auto_probe;

-- Chat draft kind `mcp_install` (propose_mcp_install), appended to whatever the constraint allows now.
CREATE FUNCTION pg_temp.widen_check_0114(t text, c text, col text, extra text[]) RETURNS void
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

SELECT pg_temp.widen_check_0114('chat_drafts', 'chat_drafts_kind_check', 'kind', ARRAY['mcp_install']);
