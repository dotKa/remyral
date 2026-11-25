/**
 * The integrator's merge step (p4-dag ↔ p4-git-flow, docs/design/p4-dag.md §6). The workflow engine never
 * merges by itself: when an integrator node succeeds it asks the gateway to merge the node's branches through
 * the git flow (protected merge behind a human `git.merge` approval, ADR-0010 rule 2). Until p4-git-flow plugs
 * in its implementation, {@link PendingMergeGateway} only records the request: the run waits in
 * `awaiting_merge` and nothing is merged.
 */
export interface MergeRequestInput {
  readonly runId: string;
  readonly nodeId: string;
  /** The integrator node's job (its attempt branch is the integration branch). */
  readonly jobId: string;
  readonly project: string;
  readonly repository: { readonly url: string; readonly baseRef: string };
  /** Upstream branch refs plus the integration branch, in a stable order. */
  readonly branches: readonly string[];
  readonly integrationBranch: string;
}

export type MergeStatus = 'pending' | 'merged' | 'refused';

/** p11-merge-pipeline: the run's integrator step integrated by the master (ADR-0041). */
export interface MasterIntegrationInput {
  readonly runId: string;
  readonly nodeId: string;
  readonly project: string;
  readonly repository: { readonly url: string; readonly baseRef: string };
  /** The user who started the run (the integration acts for them, re-authorised for every job). */
  readonly createdBy: string;
  /** The integrator's ancestor steps with their jobs; `after`: their upstream steps among these. */
  readonly members: readonly {
    readonly nodeId: string;
    readonly jobId: string;
    readonly title: string;
    readonly after: readonly string[];
  }[];
}

export interface MergeGateway {
  /**
   * p11-merge-pipeline (ADR-0041): when the project uses master-managed integration, the platform merges the
   * integrator's upstream branches itself (deterministic integration jobs, bounded conflict resolution, verification,
   * one pull request) instead of running an integrator agent. Null: not used — the integrator step runs as before.
   */
  masterIntegration?(input: MasterIntegrationInput): Promise<{
    readonly status: MergeStatus;
    readonly externalRef: string | null;
    readonly branch: string;
    readonly note: string;
  } | null>;
  /**
   * Verified changes of a job that waits in AWAITING_APPROVAL after independent verification (p4-git-flow):
   * the node's work is done and verified; its branch feeds downstream nodes. `null` = not verified/enrolled.
   */
  verifiedChange?(jobId: string): Promise<{ readonly branch: string; readonly headSha: string } | null>;
  /** Opens a merge request (idempotent per run + node is the gateway's concern). */
  requestMerge(input: MergeRequestInput): Promise<{ status: MergeStatus; externalRef: string | null }>;
  /** Polled by the engine while the request is pending. */
  status(ref: {
    readonly id: string;
    readonly runId: string;
    readonly externalRef: string | null;
  }): Promise<MergeStatus>;
}

/** Default until p4-git-flow: record only; never merges. */
export class PendingMergeGateway implements MergeGateway {
  requestMerge(): Promise<{ status: MergeStatus; externalRef: string | null }> {
    return Promise.resolve({ status: 'pending', externalRef: null });
  }

  status(): Promise<MergeStatus> {
    return Promise.resolve('pending');
  }
}
