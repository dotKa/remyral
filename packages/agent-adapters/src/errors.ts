import type { CapabilityStatus, RuntimeKind } from '@remyral/protocol';
import type { AdapterCapability } from './capabilities.js';
import type { CrashDiagnosis } from './crash-diagnosis.js';

/**
 * Stable machine-readable error codes. The worker maps these 1:1 onto protocol
 * `error` events / JOB_RESULT reasons; `capability_unsupported` is the code
 * ADR-0008 requires the API to surface.
 */
export type AdapterErrorCode =
  | 'capability_unsupported'
  | 'version_mismatch'
  | 'runtime_crashed'
  | 'cancel_timeout'
  | 'unsafe_server'
  | 'session_not_found'
  | 'session_state'
  | 'cursor_expired'
  | 'invalid_spawn_context'
  | 'secret_in_argv'
  | 'login_expired';

/** Base class: every adapter failure is typed; never a generic success. */
export abstract class AdapterError extends Error {
  abstract readonly code: AdapterErrorCode;
}

/** ADR-0008: invoking a capability that is not offered (unsupported/unverified). */
export class CapabilityUnsupportedError extends AdapterError {
  readonly code = 'capability_unsupported';
  constructor(
    readonly runtime: RuntimeKind,
    readonly capability: AdapterCapability,
    readonly status: CapabilityStatus,
    readonly reason: string,
  ) {
    super(`${runtime}: capability "${capability}" is ${status}: ${reason}`);
    this.name = 'CapabilityUnsupportedError';
  }
}

/** ADR-0012 rule 1: the installed runtime version differs from the pin. */
export class VersionMismatchError extends AdapterError {
  readonly code = 'version_mismatch';
  constructor(
    readonly runtime: RuntimeKind,
    readonly expected: string,
    readonly actual: string | undefined,
  ) {
    super(`${runtime}: version ${actual ?? '<unknown>'} does not match pinned ${expected}`);
    this.name = 'VersionMismatchError';
  }
}

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** The runtime process/server died unexpectedly (not via our cancel). */
export class RuntimeCrashedError extends AdapterError {
  readonly code = 'runtime_crashed';
  constructor(
    readonly runtime: RuntimeKind | 'process',
    readonly exit: ExitInfo | undefined,
    detail: string,
    /**
     * p22-runtime-diagnostics: why it crashed (cause, exit, redacted bounded stderr tail), when the adapter could
     * tell. The worker forwards the cause as JOB_RESULT `error.params.cause` and the tail in the message.
     */
    readonly diagnosis?: CrashDiagnosis,
  ) {
    super(`${runtime}: runtime crashed (${describeExit(exit)}): ${detail}`);
    this.name = 'RuntimeCrashedError';
  }
}

/**
 * p5-claude-auth-health: the runtime's subscription login is unusable (expired / revoked refresh token, a stale
 * refresh lock, a 401 from the provider). A re-login on the worker fixes it; retrying does not.
 */
export class LoginExpiredError extends AdapterError {
  readonly code = 'login_expired';
  constructor(
    readonly runtime: RuntimeKind,
    detail: string,
  ) {
    super(`${runtime}: the subscription login is not usable (log in again): ${detail}`);
    this.name = 'LoginExpiredError';
  }
}

/** Cancel did not reach a terminal state within the declared timeout. */
export class CancelTimeoutError extends AdapterError {
  readonly code = 'cancel_timeout';
  constructor(
    readonly timeoutMs: number,
    detail: string,
  ) {
    super(`cancel did not complete within ${String(timeoutMs)} ms: ${detail}`);
    this.name = 'CancelTimeoutError';
  }
}

/** ADR-0012 rule 2: a local server accepted (or did not refuse) an unauthenticated request. */
export class UnsafeServerError extends AdapterError {
  readonly code = 'unsafe_server';
  constructor(
    readonly url: string,
    readonly observedStatus: number | undefined,
    detail: string,
  ) {
    super(`refusing local server ${url}: ${detail}`);
    this.name = 'UnsafeServerError';
  }
}

export class SessionNotFoundError extends AdapterError {
  readonly code = 'session_not_found';
  constructor(readonly sessionId: string) {
    super(`unknown or cleaned-up session ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

/** Operation not valid in the session's current state (e.g. collectResult while running). */
export class SessionStateError extends AdapterError {
  readonly code = 'session_state';
  constructor(
    readonly sessionId: string,
    readonly state: string,
    detail: string,
  ) {
    super(`session ${sessionId} is ${state}: ${detail}`);
    this.name = 'SessionStateError';
  }
}

/** The requested cursor points before the retained event window. */
export class CursorExpiredError extends AdapterError {
  readonly code = 'cursor_expired';
  constructor(
    readonly requestedAfterSeq: number,
    readonly oldestRetainedSeq: number,
  ) {
    super(
      `cursor afterSeq=${String(requestedAfterSeq)} expired; oldest retained seq is ${String(oldestRetainedSeq)}`,
    );
    this.name = 'CursorExpiredError';
  }
}

export class InvalidSpawnContextError extends AdapterError {
  readonly code = 'invalid_spawn_context';
  constructor(detail: string) {
    super(`invalid spawn context: ${detail}`);
    this.name = 'InvalidSpawnContextError';
  }
}

/** Secrets must travel via env only, never argv (visible in `ps`). */
export class SecretInArgvError extends AdapterError {
  readonly code = 'secret_in_argv';
  constructor(readonly envName: string) {
    super(`secret ${envName} appears in the argument vector; secrets must be passed via env only`);
    this.name = 'SecretInArgvError';
  }
}

export function describeExit(exit: ExitInfo | undefined): string {
  if (!exit) return 'exit unknown';
  if (exit.signal) return `signal ${exit.signal}`;
  if (exit.code === null) return 'exit unknown';
  // p22-runtime-diagnostics: Windows NTSTATUS codes (0xC0000005 …) are readable in hex.
  if (exit.code > 0xffff || exit.code < -0xffff)
    return `exit code 0x${(exit.code >>> 0).toString(16).toUpperCase()}`;
  return `exit code ${String(exit.code)}`;
}
