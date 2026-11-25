-- p9-pagination (docs/design/p9-pagination.md): keyset orderings of lists that an owner/admin reads unscoped (no project
-- or status filter). Project- and status-scoped reads keep their existing indexes. Migration number 0072: renumber at
-- merge if a parallel change took it.

-- GET /deploy/actions without ?project / ?state: newest first by (created_at, id).
CREATE INDEX ops_actions_created_keyset_idx ON ops_actions (created_at DESC, id DESC);

-- GET /approvals without ?status: newest first by (created_at, id).
CREATE INDEX approval_requests_created_keyset_idx ON approval_requests (created_at DESC, id DESC);
