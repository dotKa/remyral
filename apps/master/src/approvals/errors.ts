import type { FloorViolation } from './policy.js';

/**
 * Approval engine errors. `code`, `httpStatus` and `publicMessage` are safe to return to clients; the
 * Error message may contain identifiers for logs.
 */
export abstract class ApprovalError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  abstract readonly publicMessage: string;
}

export class ApprovalNotFoundError extends ApprovalError {
  override name = 'ApprovalNotFoundError';
  readonly code = 'approval_not_found';
  readonly httpStatus = 404;
  readonly publicMessage = 'Approval request not found.';
  constructor(readonly requestId: string) {
    super(`approval request ${requestId.slice(0, 64)} not found`);
  }
}

export type ApprovalClosedStatus = 'approved' | 'denied' | 'expired' | 'cancelled';

/** The request was already decided (by someone else, a double click or a replay). */
export class ApprovalAlreadyDecidedError extends ApprovalError {
  override name = 'ApprovalAlreadyDecidedError';
  readonly code = 'approval_already_decided';
  readonly httpStatus = 409;
  readonly publicMessage = 'This request has already been decided.';
  constructor(
    readonly requestId: string,
    readonly status: ApprovalClosedStatus,
  ) {
    super(`approval request ${requestId} is already ${status}`);
  }
}

export class ApprovalExpiredError extends ApprovalError {
  override name = 'ApprovalExpiredError';
  readonly code = 'approval_expired';
  readonly httpStatus = 409;
  readonly publicMessage = 'This request has expired and can no longer be decided.';
  constructor(readonly requestId: string) {
    super(`approval request ${requestId} has expired`);
  }
}

export type StaleApprovalReason =
  'job_state_changed' | 'attempt_changed' | 'epoch_superseded' | 'lease_lost' | 'not_lease_holder';

/** The job moved on (new attempt/epoch, cancelled, lost lease): the request no longer applies. */
export class ApprovalStaleError extends ApprovalError {
  override name = 'ApprovalStaleError';
  readonly code = 'approval_stale';
  readonly httpStatus = 409;
  readonly publicMessage = 'The job has moved on; this request no longer applies.';
  constructor(
    readonly requestId: string | null,
    readonly reason: StaleApprovalReason,
  ) {
    super(`approval request ${requestId ?? '(new)'} is stale (${reason})`);
  }
}

export class ApprovalForbiddenError extends ApprovalError {
  override name = 'ApprovalForbiddenError';
  readonly code = 'forbidden';
  readonly httpStatus = 403;
  readonly publicMessage = 'Not allowed.';
  constructor(readonly why: 'role' | 'already_voted') {
    super(`approval refused: ${why}`);
  }
}

export class StepUpRequiredError extends ApprovalError {
  override name = 'StepUpRequiredError';
  readonly code = 'step_up_required';
  readonly httpStatus = 403;
  readonly publicMessage = 'Confirm with a current authenticator code.';
  constructor() {
    super('fresh TOTP verification required');
  }
}

export interface InvalidInputIssue {
  readonly path: string;
  readonly code: string;
}

/** Input validation failed; carries field paths and codes only, never values. */
export class InvalidApprovalInputError extends ApprovalError {
  override name = 'InvalidApprovalInputError';
  readonly code = 'invalid_input';
  readonly httpStatus = 400;
  readonly publicMessage = 'The request is invalid.';
  constructor(readonly issues: readonly InvalidInputIssue[]) {
    super(`invalid approval input: ${issues.map((i) => `${i.path || '(root)'}:${i.code}`).join(', ')}`);
  }
}

/** A project tried to configure a rule weaker than the platform floor. */
export class PolicyBelowFloorError extends ApprovalError {
  override name = 'PolicyBelowFloorError';
  readonly code = 'policy_below_platform_floor';
  readonly httpStatus = 400;
  readonly publicMessage = 'The policy is weaker than the platform minimum for some actions.';
  constructor(readonly violations: readonly FloorViolation[]) {
    super(`policy below platform floor: ${violations.map((v) => `${v.action}.${v.field}`).join(', ')}`);
  }
}

export class PolicyVersionConflictError extends ApprovalError {
  override name = 'PolicyVersionConflictError';
  readonly code = 'version_conflict';
  readonly httpStatus = 409;
  readonly publicMessage = 'The policy was changed by someone else. Reload and try again.';
  constructor(
    readonly project: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`project ${project} policy version ${String(actual)}, expected ${String(expected)}`);
  }
}

/** The job is not in a state where approvals can be requested (e.g. queued, terminal). */
export class ApprovalContextError extends ApprovalError {
  override name = 'ApprovalContextError';
  readonly code = 'approval_not_applicable';
  readonly httpStatus = 409;
  readonly publicMessage = 'Approvals cannot be requested for this job now.';
  constructor(
    readonly jobId: string,
    readonly why: string,
  ) {
    super(`job ${jobId.slice(0, 64)}: ${why}`);
  }
}
