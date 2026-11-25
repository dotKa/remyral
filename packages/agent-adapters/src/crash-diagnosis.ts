import type { ExitInfo } from './errors.js';
import { classifyProviderFailure } from './usage-limit.js';

/**
 * p22-runtime-diagnostics (docs/design/p22-runtime-diagnostics.md): why a runtime process died, from what the
 * worker can observe without trusting the runtime — the exit code / signal of the process and the last lines of its
 * stderr (already redacted). Pure; no I/O.
 *
 * The cause decides what the platform does next:
 * - `usage_limit` → the provider usage-limit path (p11-usage-limit-fallback: wait or fall back), never a retry storm;
 * - `login` → `login_expired` (p10-claude-login-health: re-login, the scheduler waits);
 * - `out_of_memory`, `killed`, `provider_overloaded`, `network`, `unknown` → a transient runtime crash the master's
 *   automatic retry handles (p15-auto-mode), with the cause shown to the user.
 */

export const CRASH_CAUSES = [
  'usage_limit',
  'login',
  'out_of_memory',
  'killed',
  'provider_overloaded',
  'network',
  'unknown',
] as const;
export type CrashCause = (typeof CRASH_CAUSES)[number];

export interface CrashDiagnosis {
  readonly cause: CrashCause;
  /** The exit as observed (code and/or signal); undefined only when the process never started or was not seen. */
  readonly exit?: ExitInfo;
  /** The last stderr lines (redacted by the caller, ≤ STDERR_TAIL_MAX_LINES lines / STDERR_TAIL_MAX_CHARS chars). */
  readonly stderrTail: string;
}

export const STDERR_TAIL_MAX_LINES = 20;
export const STDERR_TAIL_MAX_CHARS = 2000;

/** The last non-empty lines of `text`, bounded by lines and characters (the newest kept). */
export function boundedStderrTail(
  text: string | undefined,
  maxLines = STDERR_TAIL_MAX_LINES,
  maxChars = STDERR_TAIL_MAX_CHARS,
): string {
  if (text === undefined || text === '') return '';
  const lines = text
    .slice(-64 * 1024)
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  const joined = lines.slice(-maxLines).join('\n');
  return joined.length > maxChars ? `…${joined.slice(-(maxChars - 1))}` : joined;
}

const SIGNAL_NAME = /^SIG[A-Z0-9]{1,8}$/;

/**
 * The exit an error message or error object reports — the Claude Agent SDK throws "Claude Code process exited with
 * code N" / "… terminated by signal SIGX" (and tags the error with `exitCode` / `signal`); Node errors carry
 * `code` strings that are not exits. Undefined when nothing names one.
 */
export function exitFromError(err: unknown): ExitInfo | undefined {
  if (typeof err === 'object' && err !== null) {
    const o = err as { exitCode?: unknown; signal?: unknown };
    const code = typeof o.exitCode === 'number' && Number.isInteger(o.exitCode) ? o.exitCode : null;
    const signal = typeof o.signal === 'string' && SIGNAL_NAME.test(o.signal) ? o.signal : null;
    if (code !== null || signal !== null) return { code, signal: signal as NodeJS.Signals | null };
  }
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const byCode = /\bexited with code (-?\d{1,10})\b/i.exec(message);
  if (byCode?.[1] !== undefined) return { code: Number(byCode[1]), signal: null };
  const bySignal = /\b(?:terminated|killed) by signal (SIG[A-Z0-9]{1,8})\b/i.exec(message);
  if (bySignal?.[1] !== undefined) return { code: null, signal: bySignal[1].toUpperCase() as NodeJS.Signals };
  return undefined;
}

const OOM_TEXT: readonly RegExp[] = [
  /javascript heap out of memory/i,
  /\bheap limit\b[^\n]{0,60}\ballocation failed\b/i,
  /\bFATAL ERROR:[^\n]{0,80}\b(?:allocation failed|out of memory)\b/i,
  /\bENOMEM\b/,
  /\bcannot allocate memory\b/i,
  /\bout of memory\b/i,
  /\boom[- ]?kill(?:ed|er)?\b/i,
];

const NETWORK_TEXT: readonly RegExp[] = [
  /\bENOTFOUND\b|\bEAI_AGAIN\b|\bgetaddrinfo\b/,
  /\bECONNREFUSED\b|\bENETUNREACH\b|\bEHOSTUNREACH\b|\bECONNRESET\b|\bETIMEDOUT\b/,
  /\bsocket hang up\b/i,
  /\bfetch failed\b/i,
  /\b(?:api )?connection error\b/i,
  /\bunable to connect to (?:the )?(?:anthropic )?api\b/i,
  /\bnetwork (?:error|is unreachable)\b/i,
  /\brequest timed out\b/i,
];

const OVERLOADED_TEXT: readonly RegExp[] = [
  /\boverloaded(?:_error)?\b/i,
  /\b529\b/,
  /\bapi error:?\s*5\d\d\b/i,
  /\b5\d\d\b[^\n]{0,40}\b(?:server error|bad gateway|service unavailable|gateway time-?out|internal)/i,
  /\binternal server error\b/i,
  /\bservice unavailable\b/i,
];

/**
 * Windows NTSTATUS exit codes of a process killed by the system (no signals there): STATUS_NO_MEMORY (0xC0000017),
 * STATUS_COMMITMENT_LIMIT (0xC000012D); a process killed by TerminateProcess / a job object exits with the code the
 * killer chose (commonly 1), so it cannot be told apart from an ordinary error exit.
 */
const WINDOWS_OOM_CODES = new Set([0xc0000017, 0xc000012d, -1073741801, -1073741523]);

/**
 * The cause of a runtime crash. Login wording wins over everything (a re-login is the only fix), then a usage limit
 * (waiting is the fix), then memory, then a provider / network fault, then how the process died (a kill signal or the
 * 128+9 exit of a SIGKILLed child of a shell).
 */
export function diagnoseCrash(input: {
  readonly exit: ExitInfo | undefined;
  /** stderr tail and the error message (redacted). */
  readonly text: string;
}): CrashCause {
  const text = input.text.length > 64 * 1024 ? input.text.slice(-64 * 1024) : input.text;
  const provider = classifyProviderFailure(undefined, text, new Date());
  if (provider?.class === 'auth') return 'login';
  if (provider?.class === 'usage_limited') return 'usage_limit';
  const exit = input.exit;
  if (OOM_TEXT.some((re) => re.test(text))) return 'out_of_memory';
  if (exit?.code !== undefined && exit.code !== null && WINDOWS_OOM_CODES.has(exit.code))
    return 'out_of_memory';
  if (OVERLOADED_TEXT.some((re) => re.test(text))) return 'provider_overloaded';
  if (NETWORK_TEXT.some((re) => re.test(text))) return 'network';
  if (provider?.class === 'transient') return 'provider_overloaded';
  if (exit?.signal === 'SIGKILL' || exit?.code === 137) return 'killed';
  if (exit?.signal !== null && exit?.signal !== undefined) return 'killed';
  return 'unknown';
}

/** A diagnosis from an exit, the stderr tail and the error message (both redacted by the caller). */
export function crashDiagnosis(
  exit: ExitInfo | undefined,
  stderr: string | undefined,
  message: string | undefined,
): CrashDiagnosis {
  const tail = boundedStderrTail(stderr);
  const cause = diagnoseCrash({ exit, text: `${message ?? ''}\n${stderr ?? ''}` });
  return { cause, ...(exit === undefined ? {} : { exit }), stderrTail: tail };
}

/** Whether the master's automatic retry should run the job again for this cause (login / usage limit: their own path). */
export function isTransientCrash(cause: CrashCause): boolean {
  return cause !== 'login' && cause !== 'usage_limit';
}
