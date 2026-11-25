import { type Messages, messagesFor } from '@remyral/i18n';
import type { JobFilter, JobSummary } from '../../../api/jobs';

/**
 * p12-diyalog Faz 4: the job list's URL filters (the classic `?state=&project=&runtime=&worker=`, so links work in
 * both consoles), the "saved views-lite" presets on top of them, and the per-browser memory of the last view. Pure
 * except for the guarded localStorage access.
 */

export const FILTER_KEYS = ['state', 'project', 'runtime', 'worker'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

/** Narrowing the server cannot do (no `createdBy` / day filter on `GET /jobs`): applied to the loaded page. */
export type LocalView = 'today' | 'mine';
export const VIEW_PARAM = 'view';

export function filterOf(params: URLSearchParams): JobFilter {
  const f: Partial<Record<FilterKey, string>> = {};
  for (const k of FILTER_KEYS) {
    const v = params.get(k);
    if (v) f[k] = v;
  }
  return f;
}

export function localViewOf(params: URLSearchParams): LocalView | null {
  const v = params.get(VIEW_PARAM);
  return v === 'today' || v === 'mine' ? v : null;
}

export type PresetId = 'running' | 'failed' | 'approval' | 'today' | 'mine';

/** A preset's words come from the catalog (`t.jobs.presets[id]`). */
export interface Preset {
  readonly id: PresetId;
  readonly filter: JobFilter;
  readonly view: LocalView | null;
}

export const PRESETS: readonly Preset[] = [
  { id: 'running', filter: { state: 'RUNNING' }, view: null },
  { id: 'failed', filter: { state: 'FAILED' }, view: null },
  { id: 'approval', filter: { state: 'AWAITING_APPROVAL' }, view: null },
  { id: 'today', filter: {}, view: 'today' },
  { id: 'mine', filter: {}, view: 'mine' },
];

/** The preset the URL shows exactly (no other filter set), or null. */
export function activePreset(params: URLSearchParams): Preset | null {
  const f = filterOf(params);
  const view = localViewOf(params);
  return (
    PRESETS.find((p) => p.view === view && FILTER_KEYS.every((k) => (p.filter[k] ?? '') === (f[k] ?? ''))) ??
    null
  );
}

/** URL parameters for a preset (or every job for null): filters replaced, page position dropped, tab kept. */
export function paramsFor(prev: URLSearchParams, preset: Preset | null): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const k of [...FILTER_KEYS, VIEW_PARAM, 'cursor', 'page']) next.delete(k);
  if (preset !== null) {
    for (const k of FILTER_KEYS) {
      const v = preset.filter[k];
      if (v !== undefined) next.set(k, v);
    }
    if (preset.view !== null) next.set(VIEW_PARAM, preset.view);
  }
  return next;
}

/** Applies a local view to the loaded page. */
export function narrow(
  items: readonly JobSummary[],
  view: LocalView | null,
  me: string | null,
  now: number,
): readonly JobSummary[] {
  if (view === null) return items;
  if (view === 'mine') return items.filter((j) => j.createdBy.type === 'user' && j.createdBy.id === me);
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return items.filter((j) => Date.parse(j.createdAt) >= start);
}

export const VIEW_STORAGE_KEY = 'remyral.diyalog.jobs.view';

/** The last preset this browser used (a convenience; storage may be unavailable). */
export function rememberedPreset(): Preset | null {
  try {
    const id = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return PRESETS.find((p) => p.id === id) ?? null;
  } catch {
    return null;
  }
}

export function rememberPreset(p: Preset | null): void {
  try {
    if (p === null) window.localStorage.removeItem(VIEW_STORAGE_KEY);
    else window.localStorage.setItem(VIEW_STORAGE_KEY, p.id);
  } catch {
    // Private mode / blocked storage: the view simply is not remembered.
  }
}

/** "45 sn", "12 dk", "1 sa 05 dk", "2 g 3 sa" / "45 s", "12 min", "1 h 05 min", "2 d 3 h". */
export function spanText(ms: number, t: Messages): string {
  const w = t.jobs.span;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return w.seconds({ s });
  const m = Math.floor(s / 60);
  if (m < 60) return w.minutes({ m });
  const h = Math.floor(m / 60);
  if (h < 24) return w.hours({ h, m: String(m % 60).padStart(2, '0') });
  const d = Math.floor(h / 24);
  return w.days({ d, h: h % 24 });
}

const TR = messagesFor('tr');

/**
 * Turkish only — kept for screens outside İşler that have not moved to the catalog yet (the project wait policy,
 * another Phase 5 group); new code uses {@link spanText}.
 */
export function spanTr(ms: number): string {
  return spanText(ms, TR);
}

/**
 * p12-diyalog-w1: column sorting as the classic table (state, project, created, duration), applied to the loaded
 * page like the classic `DataTable` — but kept in the URL (`?sort=<key>&dir=asc|desc`) so a sorted list can be
 * linked and survives the first page's refresh. No `sort` = the server's order (newest first).
 */
export const SORT_PARAM = 'sort';
export const DIR_PARAM = 'dir';
export const SORT_KEYS = ['created', 'state', 'project', 'duration'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

export function sortLabels(t: Messages): Readonly<Record<SortKey, string>> {
  const w = t.jobs.sort;
  return { created: w.created, state: w.state, project: w.project, duration: w.duration };
}

export interface JobSort {
  readonly key: SortKey;
  readonly dir: SortDir;
}

export function sortOf(params: URLSearchParams): JobSort | null {
  const k = params.get(SORT_PARAM);
  const key = SORT_KEYS.find((s) => s === k);
  if (key === undefined) return null;
  return { key, dir: params.get(DIR_PARAM) === 'desc' ? 'desc' : 'asc' };
}

/** Next sort after pressing a column: a new column starts ascending, the same one flips, a third press clears. */
export function nextSort(cur: JobSort | null, key: SortKey): JobSort | null {
  if (cur?.key !== key) return { key, dir: 'asc' };
  return cur.dir === 'asc' ? { key, dir: 'desc' } : null;
}

export function withSort(prev: URLSearchParams, s: JobSort | null): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (s === null) {
    next.delete(SORT_PARAM);
    next.delete(DIR_PARAM);
  } else {
    next.set(SORT_PARAM, s.key);
    next.set(DIR_PARAM, s.dir);
  }
  return next;
}

/** The classic comparators (screens/JobsPage.tsx); `durationOf` = `jobDurationMs` at the current time. */
export function sortJobs(
  items: readonly JobSummary[],
  s: JobSort | null,
  durationOf: (j: JobSummary) => number,
): readonly JobSummary[] {
  if (s === null) return items;
  const cmp: (a: JobSummary, b: JobSummary) => number =
    s.key === 'state'
      ? (a, b) => a.state.localeCompare(b.state)
      : s.key === 'project'
        ? (a, b) => a.project.localeCompare(b.project)
        : s.key === 'created'
          ? (a, b) => a.createdAt.localeCompare(b.createdAt)
          : (a, b) => durationOf(a) - durationOf(b);
  const out = [...items].sort(cmp);
  return s.dir === 'desc' ? out.reverse() : out;
}
