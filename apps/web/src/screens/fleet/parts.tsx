import { type WorkerOverview } from '../../api/fleet';
import type { WorkerSummary } from '../../api/workers';

/** p5-fleet-ui building blocks (docs/design/p5-fleet-ui.md §2): pure helpers + small presentational parts. */

/** ADR-0023: the four runtimes the platform runs (OpenHands was removed). */
export const RUNTIMES = ['claude-code', 'codex', 'opencode', 'pi'] as const;
export const RUNTIME_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

export type SortKey = 'name' | 'state' | 'load' | 'seen';
export interface FleetFilter {
  readonly text: string;
  readonly state: string;
  /** Only workers where this runtime is ready (or degraded). */
  readonly runtime: string;
}

export const STATE_ORDER = ['busy', 'online', 'updating', 'draining', 'offline', 'quarantined'];

export function loadRatio(o: WorkerOverview | undefined): number {
  if (o === undefined || o.capacity.max === null || o.capacity.max === 0) return 0;
  return o.capacity.running / o.capacity.max;
}

export function filterWorkers(
  workers: readonly WorkerSummary[],
  overview: ReadonlyMap<string, WorkerOverview>,
  f: FleetFilter,
): WorkerSummary[] {
  const text = f.text.trim().toLowerCase();
  return workers.filter((w) => {
    if (f.state !== '' && w.state !== f.state) return false;
    if (
      text !== '' &&
      ![w.name, w.hostname ?? '', w.id, w.os ?? '', w.arch ?? ''].some((s) => s.toLowerCase().includes(text))
    )
      return false;
    if (f.runtime !== '') {
      const cell = overview.get(w.id)?.compatibility.find((c) => c.runtime === f.runtime);
      if (cell === undefined || (cell.status !== 'ready' && cell.status !== 'degraded')) return false;
    }
    return true;
  });
}

export function sortWorkers(
  workers: readonly WorkerSummary[],
  overview: ReadonlyMap<string, WorkerOverview>,
  key: SortKey,
): WorkerSummary[] {
  const byName = (a: WorkerSummary, b: WorkerSummary) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const rank = (s: string) => {
    const i = STATE_ORDER.indexOf(s);
    return i < 0 ? STATE_ORDER.length : i;
  };
  return [...workers].sort((a, b) => {
    if (key === 'state') return rank(a.state) - rank(b.state) || byName(a, b);
    if (key === 'load') return loadRatio(overview.get(b.id)) - loadRatio(overview.get(a.id)) || byName(a, b);
    if (key === 'seen')
      return (Date.parse(b.lastSeenAt ?? '') || 0) - (Date.parse(a.lastSeenAt ?? '') || 0) || byName(a, b);
    return byName(a, b);
  });
}

export function groupByNetwork(
  workers: readonly WorkerSummary[],
  overview: ReadonlyMap<string, WorkerOverview>,
): { key: string; label: string; workers: WorkerSummary[] }[] {
  const groups = new Map<string, { key: string; label: string; workers: WorkerSummary[] }>();
  for (const w of workers) {
    const n = overview.get(w.id)?.network ?? { key: 'unknown', label: 'Unknown network' };
    const g = groups.get(n.key) ?? { key: n.key, label: n.label, workers: [] };
    g.workers.push(w);
    groups.set(n.key, g);
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(a.key === 'unknown') - Number(b.key === 'unknown') ||
      b.workers.length - a.workers.length ||
      a.key.localeCompare(b.key),
  );
}
