-- p14-skill-catalogs (ADR-0054 decision 6, docs/design/p14-mcp-skills.md §3.3, §3.4, §4, P2): skill layout v2 with the
-- approved limits (64 files / 128 KiB per file / 512 KiB per skill, 640 KiB per job, text only), the admin-configurable
-- skill catalog sources (GitHub repositories, read through api.github.com pinned to a commit) with their cached listing,
-- and the chat draft kind `skill_import` (propose_skill_install). Additive only: older code writes nothing that the
-- wider CHECKs would reject and ignores the new table (rollback: leave it).
-- Migration number 0105 (0104 is reserved by a parallel change); renumber at merge if needed.

-- 1. Layout v2 limits on the immutable version rows (UPDATEs stay refused by the 0022 trigger; this only widens CHECKs).
ALTER TABLE skill_versions DROP CONSTRAINT skill_versions_file_count_check;
ALTER TABLE skill_versions ADD CONSTRAINT skill_versions_file_count_check CHECK (file_count BETWEEN 1 AND 64);
ALTER TABLE skill_versions DROP CONSTRAINT skill_versions_total_bytes_check;
ALTER TABLE skill_versions ADD CONSTRAINT skill_versions_total_bytes_check CHECK (total_bytes BETWEEN 0 AND 524288);
ALTER TABLE skill_versions DROP CONSTRAINT skill_versions_manifest_check;
ALTER TABLE skill_versions ADD CONSTRAINT skill_versions_manifest_check CHECK (octet_length(manifest) <= 32768);
ALTER TABLE skill_files DROP CONSTRAINT skill_files_content_check;
ALTER TABLE skill_files ADD CONSTRAINT skill_files_content_check CHECK (octet_length(content) <= 131072);
-- A layout-1 version keeps today's limits (old workers parse it).
ALTER TABLE skill_versions ADD CONSTRAINT skill_versions_layout1_limits
  CHECK (layout = 2 OR (file_count <= 32 AND total_bytes <= 131072));

-- 2. Import previews hold up to 512 KiB of text (JSON-escaped it can double).
ALTER TABLE skill_imports DROP CONSTRAINT skill_imports_files_check;
ALTER TABLE skill_imports ADD CONSTRAINT skill_imports_files_check
  CHECK (jsonb_typeof(files) = 'object' AND octet_length(files::text) <= 2097152);

-- 3. Catalog sources. A GitHub repository (owner/name), an optional ref (NULL = default branch) and the folder that
--    holds the skills. The listing (folders with a SKILL.md, frontmatter name / description, file count and size) is
--    cached here with the commit it was read at; imports from it are pinned to that commit.
CREATE TABLE skill_catalog_sources (
  id             text PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(id) <= 40),
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  repo           text NOT NULL CHECK (repo ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'),
  ref            text NULL CHECK (ref IS NULL OR ref ~ '^[A-Za-z0-9._/@+-]{1,200}$'),
  path           text NOT NULL DEFAULT '' CHECK (length(path) <= 200),
  enabled        boolean NOT NULL DEFAULT true,
  -- The built-in Anthropic source can be disabled, not deleted.
  builtin        boolean NOT NULL DEFAULT false,
  created_by     uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL,
  updated_by     uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL,
  listing        jsonb NULL CHECK (listing IS NULL OR (jsonb_typeof(listing) = 'array'
                                                       AND octet_length(listing::text) <= 1048576)),
  listing_commit text NULL CHECK (listing_commit IS NULL OR listing_commit ~ '^[0-9a-f]{40}$'),
  listed_at      timestamptz NULL,
  list_error     text NULL CHECK (list_error IS NULL OR length(list_error) <= 300),
  list_tried_at  timestamptz NULL
);
INSERT INTO skill_catalog_sources (id, title, repo, ref, path, enabled, builtin, created_at, updated_at)
VALUES ('anthropic', 'Anthropic skills', 'anthropics/skills', NULL, 'skills', true, true, now(), now())
ON CONFLICT (id) DO NOTHING;

-- 4. Chat draft kind `skill_import` (propose_skill_install), appended to whatever the constraint allows now.
DO $$
DECLARE
  def text;
  kinds text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'chat_drafts_kind_check' AND conrelid = 'chat_drafts'::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint chat_drafts_kind_check not found';
  END IF;
  IF def ~ '\{' THEN
    kinds := string_to_array(substring(def from '\{([^}]*)\}'), ',');
  ELSE
    SELECT array_agg(DISTINCT m[1]) INTO kinds FROM regexp_matches(def, '''([a-z0-9_]+)''', 'g') AS m;
  END IF;
  IF coalesce(array_length(kinds, 1), 0) < 2 THEN
    RAISE EXCEPTION 'could not read the kinds of chat_drafts_kind_check';
  END IF;
  kinds := kinds || ARRAY['skill_import'];
  SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
  ALTER TABLE chat_drafts DROP CONSTRAINT chat_drafts_kind_check;
  EXECUTE format('ALTER TABLE chat_drafts ADD CONSTRAINT chat_drafts_kind_check CHECK (kind = ANY (%L::text[]))', kinds);
END;
$$;
