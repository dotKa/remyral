import { isRetiredRuntime } from '@remyral/protocol';
import type { JobState, JobTrigger, RejectionCode } from '@remyral/scheduler';

/** Base class: `code` is stable and safe to expose through the API (p5). */
export abstract class JobStoreError extends Error {
  abstract readonly code: string;
}

export class JobNotFoundError extends JobStoreError {
  override name = 'JobNotFoundError';
  readonly code = 'job_not_found';
  constructor(readonly jobId: string) {
    super(`job ${jobId} not found`);
  }
}

export interface InvalidJobIssue {
  readonly path: string;
  readonly code: string;
}

/** Input failed validation. Carries field paths and issue codes only — never the offending values. */
export class InvalidJobError extends JobStoreError {
  override name = 'InvalidJobError';
  readonly code = 'invalid_job';
  constructor(readonly issues: readonly InvalidJobIssue[]) {
    super(`invalid job input: ${issues.map((i) => `${i.path || '(root)'}:${i.code}`).join(', ')}`);
  }
}

/** ADR-0023: why a new job, session or configuration naming a removed runtime is refused. */
export const RUNTIME_REMOVED_MESSAGE =
  'OpenHands was removed from the platform (ADR-0023). Choose Claude Code, Codex, Pi or OpenCode; past OpenHands jobs remain readable in Jobs history.';

/** ADR-0023: the job names a removed runtime (OpenHands) or an interactive OpenHands session. */
export class RuntimeRemovedError extends InvalidJobError {
  override name = 'RuntimeRemovedError';
  readonly readable = RUNTIME_REMOVED_MESSAGE;
  constructor(path = 'spec.runtime') {
    super([{ path, code: 'runtime_removed' }]);
  }
}

/** ADR-0023: does a submitted (unvalidated) job spec name a removed runtime or the removed interactive kind? */
export function namesRemovedRuntime(spec: unknown): 'spec.runtime' | 'spec.kind' | null {
  if (typeof spec !== 'object' || spec === null) return null;
  const s = spec as Record<string, unknown>;
  if (isRetiredRuntime(s.runtime)) return 'spec.runtime';
  if (s.kind === 'interactive-openhands') return 'spec.kind';
  return null;
}

export type IllegalTransitionCode =
  RejectionCode | 'no_active_lease' | 'lease_not_expired' | 'lease_held' | 'worker_mismatch';

/** The state machine (or a store-level guard) rejected the transition; nothing was written. */
export class IllegalTransitionError extends JobStoreError {
  override name = 'IllegalTransitionError';
  readonly code = 'illegal_transition';
  constructor(
    readonly jobId: string,
    readonly from: JobState,
    readonly trigger: JobTrigger,
    readonly reason: IllegalTransitionCode,
    message: string,
  ) {
    super(`job ${jobId}: ${message} (${reason})`);
  }
}

/** Optimistic concurrency: the job changed since it was read (or since `expectedVersion`). */
export class VersionConflictError extends JobStoreError {
  override name = 'VersionConflictError';
  readonly code = 'version_conflict';
  constructor(
    readonly jobId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number | null,
  ) {
    super(
      `job ${jobId} version conflict: expected ${String(expectedVersion)}, found ${
        actualVersion === null ? 'a newer version' : String(actualVersion)
      }`,
    );
  }
}

export type StaleEpochReason = 'unknown_lease' | 'not_holder' | 'superseded' | 'released' | 'expired';

/** A worker presented a fencing epoch that is not the job's current, live lease (ADR-0004 §3). */
export class StaleEpochError extends JobStoreError {
  override name = 'StaleEpochError';
  readonly code = 'stale_epoch';
  constructor(
    readonly jobId: string,
    readonly epoch: number | null,
    readonly reason: StaleEpochReason,
  ) {
    super(`job ${jobId}: epoch ${epoch === null ? '(none)' : String(epoch)} rejected (${reason})`);
  }
}

/** The job cannot be leased now: another worker won the race, or the job is not in a leasable state. */
export class LeaseConflictError extends JobStoreError {
  override name = 'LeaseConflictError';
  readonly code = 'lease_conflict';
  constructor(
    readonly jobId: string,
    readonly state: JobState | null,
    detail?: string,
  ) {
    super(
      `job ${jobId} cannot be leased${state === null ? ' (lost a concurrent race)' : ` in state ${state}`}${detail === undefined ? '' : ` (${detail})`}`,
    );
  }
}

/** A release was attempted while the worker must instead report a transition that closes the lease. */
export class LeaseReleaseRejectedError extends JobStoreError {
  override name = 'LeaseReleaseRejectedError';
  readonly code = 'lease_release_rejected';
  constructor(
    readonly jobId: string,
    readonly state: JobState,
  ) {
    super(`job ${jobId}: a lease in state ${state} is closed by reporting a transition, not by release`);
  }
}

export class DependencyCycleError extends JobStoreError {
  override name = 'DependencyCycleError';
  readonly code = 'dependency_cycle';
  constructor(
    readonly jobId: string,
    readonly dependsOnJobId: string,
  ) {
    super(`dependency ${jobId} -> ${dependsOnJobId} would create a cycle`);
  }
}

export class DependencyRejectedError extends JobStoreError {
  override name = 'DependencyRejectedError';
  readonly code = 'dependency_rejected';
  constructor(
    readonly jobId: string,
    readonly dependsOnJobId: string,
    readonly reason: 'cross_project' | 'job_already_started',
  ) {
    super(`dependency ${jobId} -> ${dependsOnJobId} rejected (${reason})`);
  }
}
