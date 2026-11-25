/**
 * Typed sandbox errors. Messages name paths, profiles and hosts — never env
 * values or secrets.
 */
export class SandboxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SandboxError';
  }
}

/** Machine-readable refusal reasons for `sandbox_unavailable`. */
export type SandboxRefusalReason =
  | 'profile_not_allowed'
  | 'profile_unsupported_on_os'
  | 'engine_unavailable'
  | 'image_unavailable'
  | 'untrusted_requires_container'
  | 'host_restricted_not_opted_in'
  | 'unconfined_not_opted_in'
  | 'runtime_has_no_sandbox'
  | 'worker_identity_unsafe'
  | 'network_policy_unsupported'
  | 'limits_unsupported';

/**
 * The job requires a profile this worker cannot provide (ADR-0007, ADR-0008:
 * refuse, never silently run weaker). Reported to the master as error code
 * `sandbox_unavailable` with the reason and an operator remedy.
 */
export class SandboxUnavailableError extends SandboxError {
  readonly code = 'sandbox_unavailable' as const;
  constructor(
    readonly profile: string,
    readonly reason: SandboxRefusalReason,
    detail: string,
    readonly remedy: string,
    /**
     * p9-queue-priority: the refusal is only about attempts running right now (T-SBX-4 concurrency): the job should
     * wait for this worker (LEASE_ACK `declineKind: "transient"`), not count as impossible here.
     */
    readonly busy: boolean = false,
  ) {
    super(`sandbox profile ${profile} unavailable (${reason}): ${detail}. Remedy: ${remedy}`);
    this.name = 'SandboxUnavailableError';
  }
}

/** Setting up the confinement failed (engine error, proxy start, profile file). */
export class SandboxSetupError extends SandboxError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SandboxSetupError';
  }
}

/** An invalid request (path outside the root, bad egress host, out-of-range limit). */
export class SandboxRequestError extends SandboxError {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`invalid sandbox request ${field}: ${reason}`);
    this.name = 'SandboxRequestError';
  }
}

/** Trusted git metadata changed while the agent ran (T-SBX-4 tamper alarm). */
export class GitMetadataTamperedError extends SandboxError {
  constructor(readonly paths: readonly string[]) {
    super(`trusted git metadata changed during the run: ${paths.join(', ')}`);
    this.name = 'GitMetadataTamperedError';
  }
}
