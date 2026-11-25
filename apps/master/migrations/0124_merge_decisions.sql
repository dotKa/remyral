-- p15-merge-approvals (docs/design/p15-merge-approvals.md): the merge decision of a verified git-flow job opens when
-- the job enters AWAITING_APPROVAL (same transaction), not when someone opens the job page.
--   * `requested_by` NULL: the request was opened by the master itself (git flow), not by a person.
--   * `approved_via = 'security_policy'`: the owner's security policy let the merge pass for an `allow-all` job
--     (ADR-0056 autonomy); such a request has no approval row and no approving user.
--   * `job_git.decision_closed_seen`: how many closed merge requests the master had seen when it last opened (or
--     decided not to open) the job's merge decision; NULL = never. The git-flow loop re-opens a decision when a request
--     closed since (refused merge, withdrawn request) and backfills jobs that were stuck before this migration.
-- Additive except the relaxed NOT NULL / CHECK (rollback: older code reads these rows; a system request shows an
-- empty requester; a policy merge would fail older code's NOT NULL — roll back only with no such rows, see §9).

ALTER TABLE git_merge_requests ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE git_merge_requests ALTER COLUMN approval_request_id DROP NOT NULL;
ALTER TABLE git_merge_requests
  ADD COLUMN approved_via text NOT NULL DEFAULT 'human' CHECK (approved_via IN ('human', 'security_policy'));
ALTER TABLE git_merge_requests DROP CONSTRAINT git_merge_requests_approved_chk;
ALTER TABLE git_merge_requests ADD CONSTRAINT git_merge_requests_approved_chk CHECK (
  status IN ('pending', 'denied', 'expired', 'cancelled') OR approved_by IS NOT NULL OR approved_via = 'security_policy');
ALTER TABLE git_merge_requests ADD CONSTRAINT git_merge_requests_source_chk CHECK (
  (approved_via = 'human' AND approval_request_id IS NOT NULL)
  OR (approved_via = 'security_policy' AND approval_request_id IS NULL AND approved_by IS NULL AND mode = 'merge'));

ALTER TABLE job_git ADD COLUMN decision_closed_seen integer NULL CHECK (decision_closed_seen >= 0);
