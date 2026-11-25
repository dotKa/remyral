import type { Queryable } from '../db/pool.js';
import { GitFlowError } from '../gitflow/errors.js';
import type { GitFlowService } from '../gitflow/service.js';
import { loadJobGit, loadMergeRequest } from '../gitflow/store.js';
import type { JobStore } from '../jobs/store.js';
import type { MergeGateway, MergeRequestInput, MergeStatus } from './merge.js';

/**
 * The integrator's merge through p4-git-flow (docs/design/p4-dag.md §6): for a project enrolled in git flow
 * the integrator job waits in AWAITING_APPROVAL with independently verified changes; the gateway opens the
 * protected merge request (`GitFlowService.request(…, 'merge')` → `git.merge` approval, admin + step-up by
 * the platform floor) on behalf of the user who started the run. Nothing merges until a human approves.
 * Projects without git flow keep the record-only behaviour (`pending`).
 */
export class GitFlowMergeGateway implements MergeGateway {
  constructor(
    private readonly deps: {
      readonly gitflow: () => GitFlowService | null;
      readonly jobs: JobStore;
      readonly db: Queryable;
    },
  ) {}

  async verifiedChange(jobId: string): Promise<{ branch: string; headSha: string } | null> {
    const jg = await loadJobGit(this.deps.db, jobId);
    if (jg?.verification !== 'passed' || jg.branch === null || jg.headSha === null) return null;
    return { branch: jg.branch, headSha: jg.headSha };
  }

  async requestMerge(input: MergeRequestInput): Promise<{ status: MergeStatus; externalRef: string | null }> {
    const flow = this.deps.gitflow();
    if (flow === null || !(await flow.usesGitFlow(this.deps.db, input.jobId))) {
      return { status: 'pending', externalRef: null };
    }
    const job = await this.deps.jobs.get(input.jobId);
    // Verified without file changes (or merged already): nothing left to merge.
    if (job?.state === 'SUCCEEDED') return { status: 'merged', externalRef: null };
    if (job?.state !== 'AWAITING_APPROVAL') return { status: 'refused', externalRef: null };
    const { rows } = await this.deps.db.query<{ created_by: string }>(
      'SELECT created_by FROM workflow_runs WHERE id = $1',
      [input.runId],
    );
    const requester = rows[0]?.created_by;
    if (requester === undefined) return { status: 'refused', externalRef: null };
    try {
      const { request } = await flow.request(
        input.jobId,
        'merge',
        { id: requester },
        {
          reason: `workflow run ${input.runId} integrator ${input.nodeId}`,
        },
      );
      return { status: 'pending', externalRef: request.id };
    } catch (err) {
      // Conflicts, base moved, CI not green, not verified: a human resolves it; the run cannot merge.
      if (err instanceof GitFlowError) return { status: 'refused', externalRef: null };
      throw err;
    }
  }

  async status(ref: {
    readonly id: string;
    readonly runId: string;
    readonly externalRef: string | null;
  }): Promise<MergeStatus> {
    if (ref.externalRef === null) return 'pending';
    const r = await loadMergeRequest(this.deps.db, { id: ref.externalRef });
    if (r === null) return 'pending';
    if (r.status === 'merged') return 'merged';
    if (['refused', 'denied', 'expired', 'cancelled', 'discarded', 'left_open'].includes(r.status))
      return 'refused';
    return 'pending';
  }
}
