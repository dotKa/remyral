import { type JobScheduling } from '../../api/jobs';

/**
 * p6-quota-scheduling (docs/design/p6-quota-scheduling.md §7): why a queued job waits — "Waiting for quota until
 * …" (its runtime is paused after a provider usage limit) or "Deferred to the off-peak window, starts at …" with
 * "Run now" — and, once it ran, which fallback runtime it used and why. Times render in the viewer's zone;
 * reasons are machine text (codes, ids, times), rendered as text.
 */

export type QueueState =
  | { readonly kind: 'quota'; readonly until: string | null }
  | { readonly kind: 'deferred'; readonly until: string | null }
  | null;

/** What a queued job waits for (deferral wins: a deferred job is not evaluated against quotas). */
export function queueState(state: string, s: JobScheduling | null): QueueState {
  if (state !== 'QUEUED' || s === null || s.status !== 'waiting') return null;
  const deferred = s.reasons.find((r) => r.code === 'deferred_off_peak');
  if (deferred !== undefined) return { kind: 'deferred', until: deferred.until };
  // p11-usage-limit-fallback: a credential / model at its usage limit waits the same way.
  const paused = s.reasons.filter((r) => r.code === 'provider_paused' || r.code === 'usage_limited');
  if (paused.length === 0) return null;
  const times = paused.flatMap((r) => (r.until === null ? [] : [r.until])).sort();
  return { kind: 'quota', until: times[0] ?? null };
}
