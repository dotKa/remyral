/**
 * p15-auto-mode (docs/design/p15-auto-mode.md §3): failure classification for automatic retries. Pure, DB-free.
 *
 * A failure is
 * - `transient`: the same job is likely to succeed when it runs again (a runtime that crashed, a machine that ran out of
 *   disk or lost its lease, an expired git token, a network or provider 5xx error, a worker restart). Retried
 *   automatically with backoff — on another eligible machine first when the cause is the machine's (`machineSpecific`);
 * - `heal`: the platform can repair the cause itself before running again (a base ref that does not exist, an attempt
 *   that diverged from the base at job start);
 * - `handled`: another service owns it (provider usage limits wait or fall back, ADR-0040);
 * - `permanent`: running again would fail the same way (invalid spec, policy refusal, a failing run, verification
 *   failed for content reasons, a timeout). `policyRefusal` marks the refusals no auto-fix job may try to get around.
 *
 * Only identifiers, error class names and fixed patterns are inspected; the message is untrusted text and never
 * echoed into decisions beyond these patterns.
 */

export type FailureClass = 'transient' | 'heal' | 'handled' | 'permanent';
export type FailurePhase = 'start' | 'run' | 'verify' | 'lost';

export interface FailureFacts {
  /** The worker's error code (`JOB_RESULT.error.code`: an error class name or a typed code), if any. */
  readonly code: string | null;
  /** The redacted failure text (worker message, verification reason, reconciliation reason). */
  readonly message: string;
  readonly phase: FailurePhase;
}

export interface FailureVerdict {
  readonly class: FailureClass;
  /** Short, stable cause id (stored, shown, translated). */
  readonly cause: FailureCause;
  /** Another machine may succeed where this one failed. */
  readonly machineSpecific: boolean;
  /** A refusal by a policy / security check: never retried, never worked around by an auto-fix job. */
  readonly policyRefusal: boolean;
}

export const FAILURE_CAUSES = [
  'runtime_crash',
  'disk_low',
  'git_auth',
  'git_network',
  'git_cache',
  'login',
  'worker_restart',
  'provider_error',
  'lease_lost',
  'publish_missing',
  'usage_limit',
  'base_ref',
  'diverged',
  'policy',
  'invalid',
  'timeout',
  'cancelled',
  'verification',
  'run_failed',
] as const;
export type FailureCause = (typeof FAILURE_CAUSES)[number];

/** Backoff of the n-th automatic retry (1-based): 1 min, 5 min, 20 min, 1 h, 2 h. */
export const RETRY_BACKOFF_SEC: readonly number[] = [60, 300, 1200, 3600, 7200];

export function retryDelaySec(n: number): number {
  return RETRY_BACKOFF_SEC[Math.min(Math.max(n, 1), RETRY_BACKOFF_SEC.length) - 1] ?? 60;
}

const verdict = (
  c: FailureClass,
  cause: FailureCause,
  machineSpecific = false,
  policyRefusal = false,
): FailureVerdict => ({ class: c, cause, machineSpecific, policyRefusal });

const GIT_AUTH =
  /invalid username or (password|token)|authentication failed|could not read username|permission denied \(publickey|bad credentials|token (has )?expired|expired token|\bhttp(?: status)? 40[13]\b|returned error: 40[13]|requested url returned error: 40[13]|git_credential_missing/i;
const GIT_NETWORK =
  /could not resolve host|connection timed out|operation timed out|connection reset|connection refused|early eof|rpc failed|the remote end hung up|unable to access|ssl_error|gnutls|network is unreachable|temporary failure in name resolution/i;
const PROVIDER_5XX =
  /\b(api error|status|http)\W{0,3}5\d\d\b|\b5\d\d (internal|bad gateway|service unavailable|gateway timeout)|internal server error|service unavailable|bad gateway|gateway timeout|overloaded|econnreset|etimedout|socket hang up|fetch failed|upstream connect error/i;
const GIT_CACHE =
  /detected dubious ownership in repository|\bbad object refs\/|\bmissing object [0-9a-f]{7,64} for refs\//i;
const WORKER_RESTART =
  /worker (was )?restart|worker stopped|daemon restart|restarted while|the worker went away|process was restarted/i;
const POLICY =
  /refused|not allowed|forbidden by|denied by|untrusted_requires|policy (refuses|denies)|approval (was )?denied|requires_container|not on the project allowlist|secret scan/i;

const POLICY_CODES = new Set([
  'RepositoryNotAllowedError',
  'InvalidRepositoryUrlError',
  'SecretScanError',
  'UnsafePathError',
  'UnsafeSymlinkError',
  'AttemptTrailerError',
  'PullRequestHeadMovedError',
  'secret_in_argv',
  'unsafe_server',
  'function_refused',
  'integration_refused',
]);
const INVALID_CODES = new Set([
  'InvalidWorkspaceIdError',
  'invalid_spawn_context',
  'capability_unsupported',
  'version_mismatch',
]);

/** Classifies one failure (see the module comment). */
export function classifyFailure(f: FailureFacts): FailureVerdict {
  const code = f.code ?? '';
  const msg = f.message;
  if (f.phase === 'verify') {
    if (/\(diverged\)|\(behind\)/.test(msg) && /not a descendant of the base at job start/.test(msg))
      return verdict('heal', 'diverged');
    if (/is absent on the remote/.test(msg)) return verdict('transient', 'publish_missing', true);
    if (/could not be inspected/.test(msg)) return verdict('transient', 'provider_error');
    return verdict('permanent', 'verification');
  }
  if (f.phase === 'lost') return verdict('transient', 'lease_lost', true);
  if (code === 'provider_usage_limit') return verdict('handled', 'usage_limit');
  // p18-project-bootstrap: a worker that knows empty repositories says so when it could not start one (an integration
  // or pull request job of an empty repository) — retrying cannot help.
  if (/base ref ".*" was not found in the repository \(the repository is empty/.test(msg))
    return verdict('permanent', 'base_ref');
  if (code === 'BaseRefNotFoundError' || /base ref ".*" was not found/.test(msg))
    return verdict('heal', 'base_ref');
  if (code === 'DiskQuotaError' || /not enough free disk space|disk_low|ENOSPC/i.test(msg))
    return verdict('transient', 'disk_low', true);
  if (code === 'RuntimeCrashedError' || code === 'runtime_crashed') {
    // p22-runtime-diagnostics: the worker's diagnosed cause (a fixed marker it writes). An overloaded provider is not
    // the machine's fault (the next attempt may stay); a login / usage limit is never retried here.
    const cause = /\(cause: ([a-z_]{1,32})\)/.exec(msg)?.[1];
    if (cause === 'login') return verdict('transient', 'login', true);
    if (cause === 'usage_limit') return verdict('handled', 'usage_limit');
    if (cause === 'provider_overloaded') return verdict('transient', 'provider_error');
    return verdict('transient', 'runtime_crash', true);
  }
  if (code === 'GitCredentialMissingError') return verdict('transient', 'git_auth', true);
  if (code === 'login_expired') return verdict('transient', 'login', true);
  if (code === 'login_refresh_contention') return verdict('transient', 'login');
  if (POLICY_CODES.has(code)) return verdict('permanent', 'policy', false, true);
  if (INVALID_CODES.has(code)) return verdict('permanent', 'invalid');
  if (code === 'max_duration_exceeded' || /exceeded its (time|duration) limit|timed out after/i.test(msg))
    return verdict('permanent', 'timeout');
  if (code === 'run_ended' && /cancel/i.test(msg)) return verdict('permanent', 'cancelled');
  if (/cancelled without a cancel request|stopped as cancelled/.test(msg))
    return verdict('permanent', 'cancelled');
  // p22-git-preflight: the machine's cached clone is broken (a ref to a missing object) or owned by another account
  // (dubious ownership). Newer workers heal both themselves; an older one fails — another machine may well succeed.
  if (GIT_CACHE.test(msg)) return verdict('transient', 'git_cache', true);
  if (
    code === 'GitCommandError' ||
    code === 'PushRejectedError' ||
    /^git /.test(msg) ||
    /\bgit (push|fetch)\b/.test(msg)
  ) {
    if (GIT_AUTH.test(msg)) return verdict('transient', 'git_auth');
    if (GIT_NETWORK.test(msg)) return verdict('transient', 'git_network', true);
  }
  if (GIT_AUTH.test(msg) && /\bgit\b|push|fetch|clone/i.test(msg)) return verdict('transient', 'git_auth');
  if (GIT_NETWORK.test(msg)) return verdict('transient', 'git_network', true);
  if (WORKER_RESTART.test(msg) || code === 'worker_restart') return verdict('transient', 'worker_restart');
  if (POLICY.test(msg)) return verdict('permanent', 'policy', false, true);
  if (PROVIDER_5XX.test(msg)) return verdict('transient', 'provider_error');
  if (/runtime crashed|exited unexpectedly|crashed before/i.test(msg))
    return verdict('transient', 'runtime_crash', true);
  return verdict('permanent', 'run_failed');
}

/**
 * Whether a transient failure of this job may be retried at all: never machine administration or function jobs (their
 * own brokers / retries), and a workspace job (web side effects cannot be verified, ADR-0004 §5) only when its runtime
 * never started.
 */
export function retryAllowedFor(
  job: { readonly kind: string | null; readonly hasRepository: boolean },
  phase: FailurePhase,
): boolean {
  if (job.kind === 'machine-admin' || job.kind === 'function') return false;
  if (!job.hasRepository && phase !== 'start') return false;
  return true;
}
