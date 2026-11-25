-- p14-web-perf (docs/design/p14-web-perf.md §6): the job list filtered by state, newest first.
--
-- `GET /jobs?state=…` (jobs/query.ts jobListQuery) orders by (created_at DESC, id DESC) and filters `state = ANY(…)`.
-- The only state index, jobs_state_idx (state, state_changed_at), cannot give that order, so for a rare state
-- (BLOCKED, LOST, FAILED — the home asks for each of them every 30 s, the ops thread for FAILED+LOST every 10 s)
-- Postgres walks the whole created_at keyset index and filters: the cost grows with the job history, not with the
-- answer. With this index the same query reads exactly the rows it returns (one range per state); the keyset
-- cursor `(created_at, id) < (…)` continues inside it.
--
-- Measured on the dev Postgres 18 with 60 000 synthetic jobs (0.5 % BLOCKED, 1 % LOST, 10 % FAILED), LIMIT 51:
-- BLOCKED walked 8 268 rows (98.8 ms cold, 1.5 ms warm) → index range, 0.9 ms warm; LOST 3 974 rows → 1.1 ms.
--
-- Plain CREATE INDEX inside the migration transaction (the runner wraps every file): it blocks writes to `jobs` for
-- the build, a few hundred ms at today's sizes. Additive only; rollback: DROP INDEX jobs_state_created_keyset_idx
-- (no code depends on it). Migration number 0110: renumber at merge if a parallel change took it.

CREATE INDEX IF NOT EXISTS jobs_state_created_keyset_idx ON jobs (state, created_at DESC, id DESC);
