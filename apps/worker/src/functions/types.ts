import type {
  AssignedTlsPin,
  FunctionCodeResult,
  FunctionCodeSpec,
  FunctionEmailResult,
  FunctionEmailSpec,
  FunctionErrorCode,
  FunctionHttpResult,
  FunctionHttpSpec,
  FunctionProbeResult,
  FunctionProbeSpec,
} from '@remyral/protocol';
import type { SecretString } from '../secrets/ref.js';

/**
 * p14-workflow-engine 14.3 (ADR-0055 §5.2): the worker side of function jobs (`JobSpec.kind = "function"`). The job
 * runner (jobs/runner.ts) verifies the lease like for any job, then hands the spec to one of these executors; their
 * result becomes the `function-result.json` artifact, a thrown {@link FunctionError} a failed JOB_RESULT with its code.
 */

/** A typed failure of a function job (JOB_RESULT `error.code`); `message` is redacted by the runner before it leaves. */
export class FunctionError extends Error {
  override name = 'FunctionError';
  constructor(
    readonly code: FunctionErrorCode,
    message: string,
    /**
     * p22-runtime-diagnostics: JOB_RESULT `error.params` — `cause` (a REASON_CAUSES variant of the code) and bounded
     * facts the console needs (host, port, certificate fingerprint). Never secrets.
     */
    readonly params?: Readonly<Record<string, string | number>>,
  ) {
    super(message);
  }
}

/** What every executor gets from the runner. */
export interface FunctionContext {
  /** Aborted on CANCEL_JOB, lease loss or the job's duration limit. */
  readonly signal: AbortSignal;
  /** A vault credential's value from this worker's secret store (`vault-<id>`), or null when it is not here. */
  readonly credential: (id: string) => Promise<SecretString | null>;
  /** Registers an exact secret value with the job's redaction (responses that echo it are cleaned). */
  readonly addSecret: (value: string) => void;
  /**
   * p22-runtime-diagnostics: certificates the project pinned per `host:port` (ASSIGN_JOB `execution.tlsPins`); absent or
   * empty: strict verification.
   */
  readonly tlsPins?: readonly AssignedTlsPin[];
  readonly log: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
}

export interface HttpExecutor {
  run(spec: FunctionHttpSpec, ctx: FunctionContext): Promise<FunctionHttpResult>;
}

export interface EmailExecutor {
  run(spec: FunctionEmailSpec, ctx: FunctionContext): Promise<FunctionEmailResult>;
}

/** p15-watches (watch-checks-v1): a watch's check of a port on this machine's loopback interface. */
export interface ProbeExecutor {
  run(spec: FunctionProbeSpec, ctx: FunctionContext): Promise<FunctionProbeResult>;
}

/** K3: JavaScript / Python in a network-less container (function-code-v1). */
export interface CodeExecutor {
  /** True while the container engine and both code images are ready (CAPABILITIES advertises function-code-v1). */
  ready(): Promise<boolean>;
  /** p14-code-images: forget the cached readiness (after the images were built), so the next `ready()` re-checks. */
  invalidate?(): void;
  run(spec: FunctionCodeSpec, ctx: FunctionContext): Promise<FunctionCodeResult>;
}
