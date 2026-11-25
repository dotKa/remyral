import { type Cron, nextRun } from '../schedules/cron.js';

/**
 * Catch-up for missed cron occurrences (docs/design/p6-automations.md §6). Pure: given the due time the sweeper
 * found and the current time, which occurrences start a run, which are recorded as skipped, and when the next one is.
 */

export type CatchUpPolicy = 'skip' | 'once' | 'all';

/** An occurrence fired within this long after its time is on time (a tick or a short restart away). */
export const ON_TIME_MS = 5 * 60_000;
/** `all`: at most this many missed occurrences are run; older ones are dropped (and counted). */
export const MAX_BACKFILL = 10;
/** Never enumerate more than this many occurrences (a year of a 5-minute cron is ~105k). */
const SCAN_LIMIT = 2_000;

export interface CatchUpPlan {
  /** Occurrences that start a run (oldest first). */
  readonly fire: readonly Date[];
  /** Occurrences recorded as one skipped run (the latest of them is its key), or null. */
  readonly skipped: { readonly at: Date; readonly count: number } | null;
  /** Missed occurrences folded into the fired one (policy `once`), for its reason text. */
  readonly folded: number;
  /** The next due time (strictly after `now`), or null when the expression never runs again. */
  readonly next: Date | null;
}

/** Every occurrence in [`from`, `now`] (inclusive; `from` is a due time the expression matched). */
export function dueOccurrences(cron: Cron, from: Date, now: Date): { list: Date[]; truncated: number } {
  const list: Date[] = [];
  let truncated = 0;
  let t: Date | null = from;
  while (t !== null && t.getTime() <= now.getTime()) {
    if (list.length < SCAN_LIMIT) list.push(t);
    else truncated++;
    if (truncated > 0 && truncated > SCAN_LIMIT * 50) break;
    t = nextRun(cron, t);
  }
  return { list, truncated };
}

export function planCatchUp(cron: Cron, due: Date, now: Date, policy: CatchUpPolicy): CatchUpPlan {
  const { list, truncated } = dueOccurrences(cron, due, now);
  const next = nextRun(cron, now);
  if (list.length === 0) return { fire: [], skipped: null, folded: 0, next };
  const latest = list[list.length - 1] ?? due;
  const total = list.length + truncated;
  const onTime = now.getTime() - latest.getTime() <= ON_TIME_MS;
  switch (policy) {
    case 'skip': {
      if (onTime) {
        const missed = total - 1;
        const prev = list[list.length - 2];
        return {
          fire: [latest],
          skipped: missed > 0 && prev !== undefined ? { at: prev, count: missed } : null,
          folded: 0,
          next,
        };
      }
      return { fire: [], skipped: { at: latest, count: total }, folded: 0, next };
    }
    case 'once':
      return { fire: [latest], skipped: null, folded: total - 1, next };
    case 'all': {
      const fire = list.slice(-MAX_BACKFILL);
      const dropped = total - fire.length;
      const firstFired = fire[0];
      const before = list[list.length - fire.length - 1];
      return {
        fire,
        skipped:
          dropped > 0 && before !== undefined && firstFired !== undefined
            ? { at: before, count: dropped }
            : null,
        folded: 0,
        next,
      };
    }
  }
}

/** A one-shot time: fire, or (policy `skip` and late) skip. */
export function planOneShot(at: Date, now: Date, policy: CatchUpPolicy): 'fire' | 'skip' {
  return policy === 'skip' && now.getTime() - at.getTime() > ON_TIME_MS ? 'skip' : 'fire';
}
