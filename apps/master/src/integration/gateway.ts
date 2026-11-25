import type { GitFlowMergeGateway } from '../workflows/gitflow-gateway.js';
import type {
  MasterIntegrationInput,
  MergeGateway,
  MergeRequestInput,
  MergeStatus,
} from '../workflows/merge.js';
import type { IntegrationService } from './service.js';
import { integrationBranchName } from '@remyral/protocol';

const PREFIX = 'integration:';

/**
 * p11-merge-pipeline (ADR-0041): the workflow engine's merge gateway with master-managed integration. A run's integrator
 * step in a project whose integration mode is `master` (and that has git flow) is integrated by the
 * {@link IntegrationService} — its external reference is `integration:<id>`, merged when the integration's one PR / the
 * protected merge landed, refused when it stopped for a person, failed or was cancelled. Everything else goes to the
 * git flow gateway unchanged.
 */
export class IntegrationMergeGateway implements MergeGateway {
  constructor(
    private readonly deps: {
      readonly inner: GitFlowMergeGateway;
      readonly integration: () => IntegrationService | null;
    },
  ) {}

  verifiedChange(jobId: string): Promise<{ branch: string; headSha: string } | null> {
    return this.deps.inner.verifiedChange(jobId);
  }

  async masterIntegration(input: MasterIntegrationInput): Promise<{
    status: MergeStatus;
    externalRef: string | null;
    branch: string;
    note: string;
  } | null> {
    const svc = this.deps.integration();
    if (svc === null) return null;
    const out = await svc.startWorkflow(input);
    if (out === null) return null;
    const branch = integrationBranchName(input.runId);
    if ('refused' in out) {
      return {
        status: 'refused',
        externalRef: null,
        branch,
        note: `master integration refused: ${out.refused}`,
      };
    }
    return {
      status: 'pending',
      externalRef: `${PREFIX}${out.id}`,
      branch,
      note: `integrated by the master into ${branch} (one pull request; merging stays a human decision)`,
    };
  }

  requestMerge(input: MergeRequestInput): Promise<{ status: MergeStatus; externalRef: string | null }> {
    return this.deps.inner.requestMerge(input);
  }

  async status(ref: {
    readonly id: string;
    readonly runId: string;
    readonly externalRef: string | null;
  }): Promise<MergeStatus> {
    if (ref.externalRef?.startsWith(PREFIX) === true) {
      const svc = this.deps.integration();
      if (svc === null) return 'pending';
      return svc.workflowStatus(ref.externalRef.slice(PREFIX.length));
    }
    return this.deps.inner.status(ref);
  }
}
