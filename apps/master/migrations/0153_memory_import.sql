-- p17-memory-import (docs/design/p17-memory-import.md): importing a person's memory from their own AI assistant
-- (Claude, ChatGPT, Gemini, …) as reviewed memory records.
--
--  * memory_imports: one row per import batch — who, from which assistant (the provenance "import: <assistant>"), the
--    export prompt version, a SHA-256 of the pasted / uploaded text (never the text itself), counts, the scopes it
--    wrote to, whether meaning-based de-duplication was consented, and "Bu içe aktarmayı geri al" (undone_at /
--    undone_by). Audited `memory.import` / `memory.import.undo`.
--  * memory_records.import_id: the batch a record came from (NULL for everything else). Undoing a batch rejects its
--    still-active records through the ordinary record lifecycle (history kept).
--
-- Additive. Rollback: an older master ignores both; imported records stay ordinary records (author human, provenance
-- type `import` on their first version). To drop: ALTER TABLE memory_records DROP COLUMN import_id; DROP TABLE
-- memory_imports.

CREATE TABLE memory_imports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- claude | chatgpt | gemini | other (the label then names it).
  assistant        text NOT NULL CHECK (assistant IN ('claude', 'chatgpt', 'gemini', 'copilot', 'other')),
  assistant_label  text NULL CHECK (assistant_label IS NULL OR char_length(assistant_label) BETWEEN 1 AND 40),
  prompt_version   smallint NULL CHECK (prompt_version IS NULL OR prompt_version >= 1),
  format           text NOT NULL CHECK (format IN ('jsonl', 'json', 'markdown', 'text', 'edited')),
  source_sha256    text NULL CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  source_bytes     integer NULL CHECK (source_bytes IS NULL OR source_bytes BETWEEN 0 AND 262144),
  items_total      integer NOT NULL CHECK (items_total BETWEEN 0 AND 200),
  items_imported   integer NOT NULL DEFAULT 0 CHECK (items_imported >= 0),
  items_failed     integer NOT NULL DEFAULT 0 CHECK (items_failed >= 0),
  -- The record scopes written to (`user:<id>`, `project:<id>`, `global`).
  scopes           text[] NOT NULL DEFAULT '{}' CHECK (cardinality(scopes) <= 50),
  -- Items the person imported although a check had flagged them (instruction heuristic, personal data, …).
  flagged_imported integer NOT NULL DEFAULT 0 CHECK (flagged_imported >= 0),
  semantic         boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL,
  undone_at        timestamptz NULL,
  undone_by        uuid NULL REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX memory_imports_user ON memory_imports (user_id, created_at DESC);

ALTER TABLE memory_records
  ADD COLUMN import_id uuid NULL REFERENCES memory_imports (id) ON DELETE SET NULL;

CREATE INDEX memory_records_import ON memory_records (import_id) WHERE import_id IS NOT NULL;
