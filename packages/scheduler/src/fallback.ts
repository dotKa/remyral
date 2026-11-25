/**
 * p6-quota-scheduling: fallback runtimes (docs/design/p6-quota-scheduling.md §3). Pure; the master tries a job's
 * runtimes in order and uses the first one a machine can start now.
 *
 * Rule: the next runtime is tried when the current one is not placed and no machine is merely busy with it — a
 * machine that could run the job with this runtime but has no free slot (`no_free_slot` only) means the job waits
 * for it rather than switching runtime. Paused (provider usage limit), not installed, not logged in, not enabled,
 * unusable model profile or offline machines all let the next runtime try. A job-level hold falls through only
 * when every hold reason is about the runtime (`runtime_concurrency`); a project hold, budget or dependency holds
 * the job whatever runtime it would use.
 */
import type { PlacementResult, ReasonSummary } from './placement.js';

/**
 * Reasons that mean "this machine could run it, it is just full" (p9-queue-priority adds the per-profile slot, the
 * urgent reserve and a busy decline): the job waits for the machine instead of switching runtime.
 */
export const BUSY_CODES: ReadonlySet<string> = new Set([
  'no_free_slot',
  'no_free_profile_slot',
  'urgent_slot_reserved',
  'declined_busy',
  // p9-queue-local-login-accounting: a subscription login that runs one at a time is busy, not unusable.
  'subscription_login_exclusive',
  // p9-subjob-local-login-deadlock: the same subscription login store is in use right now.
  'subscription_login_busy',
]);

/** Hold codes that concern only the runtime of the job (another runtime is not held by them). */
/** p11-usage-limit-fallback: `usage_limited` — the option's credential / model is at its usage limit. */
const RUNTIME_HOLDS: ReadonlySet<string> = new Set(['runtime_concurrency', 'usage_limited']);

/** One runtime option of a job: index 0 is the job's own runtime, then its fallbacks in order. */
export interface RuntimeOption<T> {
  readonly index: number;
  readonly runtime: string;
  readonly value: T;
}

/** The options of a job in order (the job's runtime first). */
export function runtimeOptions<T extends { readonly runtime: string }>(
  primary: T,
  fallbacks: readonly T[] | undefined,
): RuntimeOption<T>[] {
  return [primary, ...(fallbacks ?? [])].map((value, index) => ({ index, runtime: value.runtime, value }));
}

/** Whether a not-placed placement lets the next runtime option try (see the module rule). */
export function placementAllowsFallback(result: PlacementResult): boolean {
  if (result.kind === 'placed') return false;
  return !result.rejected.some((r) => r.reasons.length > 0 && r.reasons.every((x) => BUSY_CODES.has(x.code)));
}

/** Whether a job-level hold of one runtime option lets the next option try. */
export function holdAllowsFallback(reasons: readonly ReasonSummary[]): boolean {
  return reasons.length > 0 && reasons.every((r) => RUNTIME_HOLDS.has(r.code));
}

/**
 * One line that says why an option was passed over ("claude-code: provider_paused until … [w1]; runtime_not_installed
 * [w2]"), ≤ 500 characters; built from codes, worker ids and times only (no worker-supplied text).
 */
export function passedOverReason(runtime: string, reasons: readonly ReasonSummary[]): string {
  const parts = reasons.map((r) => {
    const until = r.until === undefined ? '' : ` until ${r.until}`;
    const workers = r.workers.length === 0 ? '' : ` [${r.workers.slice(0, 5).join(', ')}]`;
    return `${r.code}${until}${workers}`;
  });
  const text = `${runtime}: ${parts.length === 0 ? 'not available' : parts.join('; ')}`;
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

/**
 * The reasons a job waits with when no option could start: the first option's reasons, then each fallback's
 * with its runtime named in the message. `until` (earliest) is kept per reason.
 */
export function combinedWaitReasons(
  outcomes: readonly {
    readonly runtime: string;
    readonly index: number;
    readonly reasons: readonly ReasonSummary[];
  }[],
): ReasonSummary[] {
  return outcomes.flatMap((o) =>
    o.index === 0
      ? [...o.reasons]
      : o.reasons.map((r) => ({ ...r, message: `fallback ${o.runtime}: ${r.message}` })),
  );
}

/** The earliest `until` of the given reasons (ISO-8601), e.g. when the first paused runtime resumes. */
export function earliestUntil(reasons: readonly ReasonSummary[], code?: string): string | undefined {
  let min: string | undefined;
  for (const r of reasons) {
    if (code !== undefined && r.code !== code) continue;
    if (r.until !== undefined && (min === undefined || r.until < min)) min = r.until;
  }
  return min;
}
