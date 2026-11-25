-- p11-fixes-a (docs/design/p10-verify-health.md §11): platform report jobs never go through git flow.
-- A verifier job (job verification, the integration's verification) and a post-deploy screenshot job return their
-- report as a site-bundle artifact; they never commit, push or wait for a merge approval. Before this, a repository
-- verifier in a git-flow project committed its report folder, ended in AWAITING_APPROVAL and the verification (and a
-- gated deploy on success) waited forever. The row is written in the job's creation transaction by the master only
-- (never from a request body); `GitFlowService.prepareDispatch` skips a job that has one, so the job gets no job_git
-- row, its assignment has no `pushResult` and it ends SUCCEEDED with its report.
-- Migration number 0090 (0091–0093 = parallel p11 work; renumber at merge if taken). Additive only.
CREATE TABLE report_only_jobs (
  job_id      uuid PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify', 'health', 'integration-verify')),
  created_at  timestamptz NOT NULL
);

-- p11-fixes-a (docs/design/p9-queue-priority.md §11): the urgent (Acil) reserve's default applies only on machines with
-- at least 3 usable parallel slots. NULL = the default (no admin setting): 1 slot from 3 slots on, 0 below; a number =
-- an admin's explicit setting (0, 1 or 2; applies from 2 slots on, as before). Existing rows still at the old column
-- default 1 that no admin ever set (no successful `worker.urgent_reserve.update` audit event) become the default.
ALTER TABLE workers ALTER COLUMN urgent_reserve DROP NOT NULL;
ALTER TABLE workers ALTER COLUMN urgent_reserve DROP DEFAULT;
UPDATE workers w SET urgent_reserve = NULL
 WHERE w.urgent_reserve = 1
   AND NOT EXISTS (SELECT 1 FROM audit_events a
                    WHERE a.action = 'worker.urgent_reserve.update' AND a.outcome = 'success'
                      AND a.target = 'worker:' || w.id);
