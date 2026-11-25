-- p10-approval-readable (docs/design/p10-approval-readable.md): the structured fields of the tool call behind an
-- in-run approval request (APPROVAL_REQUEST `details`: tool, the agent's own description, the full command up to
-- 16 KiB, shell, cwd, workspace root, paths, url). Validated and pattern-redacted by the master before it is stored;
-- untrusted runtime text, shown as text only. NULL for requests of older workers and for gate requests (the console
-- then shows `summary` as before). Migration number 0085 (0084 = p10-publish-bundle; renumber at merge if a parallel
-- change took it). Additive only.
ALTER TABLE approval_requests
  ADD COLUMN details jsonb NULL
    CHECK (details IS NULL OR (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 65536));
