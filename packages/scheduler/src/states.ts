/**
 * Job states (ARCHITECTURE.md "Job state machine"). The order is the happy path followed by the detours;
 * migration 0003 mirrors this list in the `job_state` Postgres enum (a master integration test compares them).
 */
export const JOB_STATES = [
  'DRAFT',
  'QUEUED',
  'RESERVED',
  'STARTING',
  'RUNNING',
  'VERIFYING',
  'AWAITING_APPROVAL',
  'SUCCEEDED',
  'RETRY_WAIT',
  'FAILED',
  'CANCELLING',
  'CANCELLED',
  'BLOCKED',
  'LOST',
  /**
   * p10-approval-pause: the run waited too long for an in-run approval; its worker stopped the runtime, freed the slot
   * and kept the workspace and the runtime session. The attempt stays open (like LOST) and continues on the same
   * machine under a new fencing epoch once the request is decided. Appended last: migration 0079 adds the value to the
   * `job_state` enum with `ALTER TYPE … ADD VALUE`, which appends.
   */
  'PAUSED',
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Named triggers. Every state change is caused by exactly one of these. */
export const JOB_TRIGGERS = [
  'submit',
  'reserve',
  'lease_acked',
  'lease_declined',
  'runtime_started',
  'run_finished',
  'verification_passed',
  'verification_passed_no_approval',
  'verification_failed',
  'approval_granted',
  'approval_denied',
  // p15-merge-approvals: the owner's security policy (ADR-0056 autonomy) approved a verified result.
  'approval_auto_granted',
  'attempt_failed',
  'attempt_retry',
  'retry_due',
  'cancel_requested',
  'cancel_confirmed',
  'lease_expired',
  'reconcile_resume',
  'reconcile_finished',
  'reconcile_retry',
  'reconcile_fail',
  'dependency_blocked',
  'dependency_unblocked',
  'dependency_failed',
  'infeasible',
  // p10-approval-pause.
  'pause_confirmed',
  'resume_paused',
  'resume_declined',
  'restart_paused',
  'reconcile_pause',
] as const;
export type JobTrigger = (typeof JOB_TRIGGERS)[number];

/** Who may cause a transition. Approvals are human-only (ADR-0010); workers only report on their lease. */
export const ACTOR_TYPES = ['user', 'worker', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** Terminal states are immutable: no transition leaves them (enforced here and by a DB trigger). */
export const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>(['SUCCEEDED', 'FAILED', 'CANCELLED']);

/**
 * States in which an attempt is open: a worker holds (or held, for LOST) a lease and may still be acting.
 * Leaving this set ends the current attempt and closes its lease.
 */
export const ATTEMPT_OPEN_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'RESERVED',
  'STARTING',
  'RUNNING',
  'VERIFYING',
  'CANCELLING',
  'LOST',
  // p10-approval-pause: no lease and no slot, but the attempt (workspace, runtime session) continues later.
  'PAUSED',
]);

export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled' | 'retry' | 'declined';

const STATE_SET: ReadonlySet<string> = new Set(JOB_STATES);
const TRIGGER_SET: ReadonlySet<string> = new Set(JOB_TRIGGERS);

export function isJobState(value: unknown): value is JobState {
  return typeof value === 'string' && STATE_SET.has(value);
}

export function isJobTrigger(value: unknown): value is JobTrigger {
  return typeof value === 'string' && TRIGGER_SET.has(value);
}

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Outcome recorded on the attempt that ends when the job moves from an attempt-open state to `to`.
 * Returns undefined when `to` keeps the attempt open. `from`: a paused attempt that is restarted from scratch
 * (PAUSED → QUEUED, p10-approval-pause) was abandoned by a human, not declined by its worker.
 */
export function attemptOutcomeFor(to: JobState, from?: JobState): AttemptOutcome | undefined {
  if (from === 'PAUSED' && to === 'QUEUED') return 'cancelled';
  switch (to) {
    case 'AWAITING_APPROVAL':
    case 'SUCCEEDED':
      return 'succeeded';
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
      return 'cancelled';
    case 'RETRY_WAIT':
      return 'retry';
    case 'QUEUED':
      return 'declined';
    default:
      return undefined;
  }
}
