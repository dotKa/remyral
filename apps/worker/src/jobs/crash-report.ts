import {
  type CrashDiagnosis,
  describeExit,
  PROVIDER_USAGE_LIMIT,
  RuntimeCrashedError,
  usageLimitFromError,
  type UsageLimitSignal,
} from '@remyral/agent-adapters';

/**
 * p22-runtime-diagnostics (docs/design/p22-runtime-diagnostics.md): the JOB_RESULT error of a runtime that crashed —
 * the cause the adapter diagnosed goes to `error.params.cause` (the console says it in TR / EN; the master's automatic
 * retry reads the code), the exit and the last stderr lines (redacted by the adapter, redacted again by the runner)
 * to the message. A usage limit that killed the CLI at start-up becomes `provider_usage_limit` (p11-usage-limit-fallback
 * waits or falls back instead of retrying into the same limit). Pure.
 */

export interface CrashFailure {
  readonly code: string;
  readonly message: string;
  readonly params?: { readonly cause: string };
  /** With code `provider_usage_limit`: what the runtime said about the limit. */
  readonly usageLimit?: UsageLimitSignal;
}

/** Message bound (the JOB_RESULT error message; the runner redacts and cuts again). */
const MAX_MESSAGE = 1900;

/** The message of a diagnosed crash: what happened, the exit and the stderr tail. */
export function crashMessage(head: string, d: CrashDiagnosis): string {
  const exit = d.exit === undefined ? '' : ` [${describeExit(d.exit)}]`;
  const tail = d.stderrTail === '' ? '' : `\nstderr (last lines):\n${d.stderrTail}`;
  const text = `${head}${head.includes(describeExit(d.exit)) ? '' : exit} (cause: ${d.cause})${tail}`;
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

/** A thrown start-up crash with a diagnosis → its JOB_RESULT error; null for any other error. */
export function crashFailureOf(err: unknown, now: Date): CrashFailure | null {
  if (!(err instanceof RuntimeCrashedError) || err.diagnosis === undefined) return null;
  const d = err.diagnosis;
  if (d.cause === 'usage_limit') {
    const signal = usageLimitFromError(undefined, `${err.message}\n${d.stderrTail}`, now);
    return {
      code: PROVIDER_USAGE_LIMIT,
      message:
        signal?.resetAt === undefined
          ? "the provider's usage limit was reached; the reset time was not reported"
          : `the provider's usage limit was reached; it resets at ${signal.resetAt.toISOString()}`,
      ...(signal === null ? {} : { usageLimit: signal }),
    };
  }
  // `runtime_crashed` (not the class name): the console's reason code, the same the adapter uses for a mid-run crash.
  return { code: 'runtime_crashed', message: crashMessage(err.message, d), params: { cause: d.cause } };
}

/** The JOB_RESULT error of a run that ended `runtime_crashed` with a diagnosis (the crash happened mid-run). */
export function crashResultFailure(crash: CrashDiagnosis, summary: string | undefined): CrashFailure {
  return {
    code: 'runtime_crashed',
    message: crashMessage(
      `the runtime crashed${summary === undefined ? '' : `: ${summary.slice(0, 600)}`}`,
      crash,
    ),
    params: { cause: crash.cause },
  };
}
