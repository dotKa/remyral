import type { Transition } from '../../api/jobs';

/** A run of repeated steps folded into one row (e.g. a job offered to a busy machine again and again). */
export interface FoldedRun {
  readonly kind: 'folded';
  readonly id: string;
  readonly cycle: readonly Transition[];
  readonly times: number;
  readonly first: Transition;
  readonly last: Transition;
}
export type TimelineRow = { readonly kind: 'step'; readonly t: Transition } | FoldedRun;

const stepKey = (t: Transition): string => `${t.from ?? ''}>${t.to}:${t.trigger}`;

/**
 * Folds consecutive repeats of the same 1- or 2-step cycle (≥ 3 times) into one row, so a retry loop
 * (Queued → Reserved → Queued …) does not grow the page without end. The last step always stays visible.
 */
export function foldTimeline(steps: readonly Transition[], minTimes = 3): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let i = 0;
  while (i < steps.length) {
    let folded = false;
    for (const len of [2, 1]) {
      const cycle = steps.slice(i, i + len);
      if (cycle.length < len) continue;
      const keys = cycle.map(stepKey);
      let times = 1;
      while (
        i + (times + 1) * len <= steps.length - 1 &&
        steps.slice(i + times * len, i + (times + 1) * len).every((t, k) => stepKey(t) === keys[k])
      ) {
        times += 1;
      }
      if (times >= minTimes) {
        const end = i + times * len - 1;
        rows.push({
          kind: 'folded',
          id: `fold-${cycle[0]?.id ?? String(i)}`,
          cycle,
          times,
          first: steps[i] as Transition,
          last: steps[end] as Transition,
        });
        i = end + 1;
        folded = true;
        break;
      }
    }
    if (!folded) {
      rows.push({ kind: 'step', t: steps[i] as Transition });
      i += 1;
    }
  }
  return rows;
}
