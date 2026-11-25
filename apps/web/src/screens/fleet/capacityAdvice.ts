import type { CapacityAdvice, Parallelism } from '../../api/fleet';
import { RUNTIME_LABEL } from './parts';

/**
 * p6-capacity-advice (docs/design/p6-capacity-advice.md §5): the machine's recommended parallel jobs, which value is
 * in effect and why, a warning when the panel configuration asks for more, and a one-click "Apply" through the
 * managed configuration (step-up, like every configuration change).
 */

const GB = 2 ** 30;

/** "8 GB" / "1.2 GB" (binary GB, as operating systems show RAM). */
export function formatGb(bytes: number): string {
  const v = bytes / GB;
  return `${v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)} GB`;
}

function runtimeLabel(r: string): string {
  return RUNTIME_LABEL[r] ?? r;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** "Recommended: 3 parallel jobs — 4 CPUs, 8 GB RAM, Claude Code peaks ~1.2 GB". */
export function adviceSentence(a: CapacityAdvice): string {
  const peak = a.basis;
  return `Recommended: ${plural(a.recommended, 'parallel job')} — ${plural(a.cpuCount, 'CPU')}, ${formatGb(
    a.memoryBytes,
  )} RAM, ${runtimeLabel(peak.runtime)} ${peak.source === 'default' ? 'needs' : 'peaks'} ~${formatGb(peak.peakBytes)}`;
}

/** The value the warning compares: the panel configuration, else what the machine runs. */
export function requestedParallelism(p: Parallelism | null): number | null {
  if (p === null) return null;
  return p.configured ?? p.effective;
}
