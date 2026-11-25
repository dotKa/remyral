import type { SecretFinding, WriteViolation } from '@remyral/memory';

/**
 * Context store errors. `code`, `httpStatus`, `publicMessage` and `details()` are safe to return to
 * clients (identifiers, field names and positions only — never submitted values).
 */
export abstract class ContextError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  abstract readonly publicMessage: string;
  details(): Record<string, unknown> {
    return {};
  }
}

export class ContextNotFoundError extends ContextError {
  override name = 'ContextNotFoundError';
  readonly code = 'context_doc_not_found';
  readonly httpStatus = 404;
  readonly publicMessage = 'Context document not found.';
  constructor(what: string) {
    super(`context ${what.slice(0, 80)} not found`);
  }
}

export class ContextForbiddenError extends ContextError {
  override name = 'ContextForbiddenError';
  readonly code = 'forbidden';
  readonly httpStatus = 403;
  readonly publicMessage = 'Not allowed.';
  constructor(readonly why: string) {
    super(`context access refused: ${why}`);
  }
}

export class ContextStepUpRequiredError extends ContextError {
  override name = 'ContextStepUpRequiredError';
  readonly code = 'step_up_required';
  readonly httpStatus = 403;
  readonly publicMessage = 'Confirm with a current authenticator code.';
  constructor() {
    super('fresh TOTP verification required');
  }
}

export class InvalidContextInputError extends ContextError {
  override name = 'InvalidContextInputError';
  readonly code = 'invalid_input';
  readonly httpStatus = 400;
  readonly publicMessage = 'The request is invalid.';
  constructor(readonly issues: readonly WriteViolation[]) {
    super(`invalid context input: ${issues.map((i) => `${i.field}:${i.code}`).join(', ')}`);
  }
  override details(): Record<string, unknown> {
    return { issues: this.issues.map((i) => ({ field: i.field, code: i.code })) };
  }
}

/** A write contained a secret-looking value (ADR-0006). Nothing was stored. */
export class SecretDetectedError extends ContextError {
  override name = 'SecretDetectedError';
  readonly code = 'context_secret_detected';
  readonly httpStatus = 400;
  readonly publicMessage =
    'The text contains what looks like a secret (key, token, password or private key). Remove it; ' +
    'context must never hold secrets.';
  constructor(readonly findings: readonly SecretFinding[]) {
    super(`secret-looking value in ${findings.map((f) => `${f.field}:${String(f.line)}`).join(', ')}`);
  }
  override details(): Record<string, unknown> {
    return {
      findings: this.findings.map((f) => ({ field: f.field, line: f.line, column: f.column, rule: f.rule })),
    };
  }
}

export class ContextVersionConflictError extends ContextError {
  override name = 'ContextVersionConflictError';
  readonly code = 'version_conflict';
  readonly httpStatus = 409;
  readonly publicMessage = 'The document was changed by someone else. Reload and try again.';
  constructor(
    readonly docId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`context document ${docId} at version ${String(actual)}, expected ${String(expected)}`);
  }
}

export class ContextDeletedError extends ContextError {
  override name = 'ContextDeletedError';
  readonly code = 'context_doc_deleted';
  readonly httpStatus = 409;
  readonly publicMessage = 'The document has been deleted.';
  constructor(readonly docId: string) {
    super(`context document ${docId} is deleted`);
  }
}

/** A job's pinned bundle can no longer be reproduced (a pinned version was deleted, purged or revoked). */
export class ContextBundleUnavailableError extends ContextError {
  override name = 'ContextBundleUnavailableError';
  readonly code = 'context_bundle_unavailable';
  readonly httpStatus = 409;
  readonly publicMessage = 'The context pinned for this job is no longer available.';
  constructor(
    readonly jobId: string,
    readonly why: string,
  ) {
    super(`pinned context bundle for job ${jobId}: ${why}`);
  }
}

/** p6-context-policy: the namespace is under legal hold; nothing in it may be deleted. */
export class ContextLegalHoldError extends ContextError {
  override name = 'ContextLegalHoldError';
  readonly code = 'context_legal_hold';
  readonly httpStatus = 409;
  readonly publicMessage = 'This namespace is under legal hold; its documents cannot be deleted.';
  constructor(readonly namespace: string) {
    super(`context namespace ${namespace.slice(0, 140)} is under legal hold`);
  }
}

/** p6-context-policy: a resolved bundle contained a document the project may not read (T-INJ-5). */
export class ContextLeakBlockedError extends ContextError {
  override name = 'ContextLeakBlockedError';
  readonly code = 'context_leak_blocked';
  readonly httpStatus = 409;
  readonly publicMessage = 'The context bundle failed the cross-project leak check and was not issued.';
  constructor(readonly findings: readonly { docId: string; reason: string }[]) {
    super(`context leak check failed: ${findings.map((f) => `${f.docId}:${f.reason}`).join(', ')}`);
  }
}

/** p6-context-policy: an agent memory write was refused by the namespace's memory-write policy. */
export class MemoryWriteRefusedError extends ContextError {
  override name = 'MemoryWriteRefusedError';
  readonly httpStatus: number;
  readonly publicMessage = 'The memory was refused by the memory-write policy of the project.';
  constructor(readonly code: string) {
    super(`agent memory refused: ${code}`);
    this.httpStatus = code === 'memory_rate_limited' || code === 'memory_job_quota' ? 429 : 403;
  }
}

/** p6-context-policy: optimistic concurrency on namespace policies. */
export class ContextPolicyConflictError extends ContextError {
  override name = 'ContextPolicyConflictError';
  readonly code = 'version_conflict';
  readonly httpStatus = 409;
  readonly publicMessage = 'The policy was changed by someone else. Reload and try again.';
  constructor(readonly namespace: string) {
    super(`context policy ${namespace.slice(0, 140)} changed concurrently`);
  }
}
