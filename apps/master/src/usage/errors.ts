/**
 * Usage/cost errors. `code`, `httpStatus`, `publicMessage` and `details()` are safe to return to clients
 * (identifiers and field names only — never submitted values).
 */
export abstract class UsageError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  abstract readonly publicMessage: string;
  details(): Record<string, unknown> {
    return {};
  }
}

export interface InputIssue {
  readonly field: string;
  readonly code: string;
}

export class InvalidUsageInputError extends UsageError {
  override name = 'InvalidUsageInputError';
  readonly code = 'invalid_input';
  readonly httpStatus = 400;
  readonly publicMessage = 'The request is invalid.';
  constructor(readonly issues: readonly InputIssue[]) {
    super(`invalid usage input: ${issues.map((i) => `${i.field}:${i.code}`).join(', ')}`);
  }
  override details(): Record<string, unknown> {
    return { issues: this.issues.map((i) => ({ field: i.field, code: i.code })) };
  }
}

export class UsageForbiddenError extends UsageError {
  override name = 'UsageForbiddenError';
  readonly code = 'forbidden';
  readonly httpStatus = 403;
  readonly publicMessage = 'Not allowed.';
  constructor(readonly why: string) {
    super(`usage access refused: ${why}`);
  }
}

export class UsageStepUpRequiredError extends UsageError {
  override name = 'UsageStepUpRequiredError';
  readonly code = 'step_up_required';
  readonly httpStatus = 403;
  readonly publicMessage = 'Confirm with a current authenticator code.';
  constructor() {
    super('fresh TOTP verification required');
  }
}

export class UsageNotFoundError extends UsageError {
  override name = 'UsageNotFoundError';
  readonly code = 'not_found';
  readonly httpStatus = 404;
  readonly publicMessage = 'Not found.';
  constructor(what: string) {
    super(`${what.slice(0, 80)} not found`);
  }
}

export class UsageVersionConflictError extends UsageError {
  override name = 'UsageVersionConflictError';
  readonly code = 'version_conflict';
  readonly httpStatus = 409;
  readonly publicMessage = 'It was changed by someone else. Reload and try again.';
  constructor(
    readonly what: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`${what} at version ${String(actual)}, expected ${String(expected)}`);
  }
}

/** A usage event that cannot be attributed (wrong attempt/worker, malformed event). Transport-facing. */
export class UsageRejectedError extends UsageError {
  override name = 'UsageRejectedError';
  readonly code = 'usage_rejected';
  readonly httpStatus = 422;
  readonly publicMessage = 'The usage event was rejected.';
  constructor(readonly reason: string) {
    super(`usage event rejected: ${reason}`);
  }
}
