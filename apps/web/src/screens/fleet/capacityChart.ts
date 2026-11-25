import { type CapacityEvent } from '../../api/capacity';

/** The slots over time: the value after every change that set one (suggestions are drawn as dots). */
export function chartSeries(
  events: readonly CapacityEvent[],
  now: number,
  current: number | null,
): { line: { t: number; v: number }[]; dots: { t: number; v: number }[] } {
  const line: { t: number; v: number }[] = [];
  const dots: { t: number; v: number }[] = [];
  for (const e of events) {
    const t = Date.parse(e.at);
    if (!Number.isFinite(t) || e.to === null) continue;
    if (e.kind === 'suggest') dots.push({ t, v: e.to });
    else {
      if (line.length === 0 && e.from !== null) line.push({ t, v: e.from });
      line.push({ t, v: e.to });
    }
  }
  if (current !== null) {
    if (line.length === 0) line.push({ t: now - 60_000, v: current });
    line.push({ t: Math.max(now, line.at(-1)?.t ?? now), v: current });
  }
  return { line, dots };
}
