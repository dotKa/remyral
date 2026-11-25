import { type ReactNode, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { cx } from '../../components/ui';
import { useT } from '../../i18n/I18nProvider';
import { DyIcon } from '../icons';

/**
 * p12-diyalog-final: sortable lists in the Diyalog UI — the classic `DataTable` sortable columns as a documented
 * equivalent. Diyalog lists are row lists (`Rows` / `Row`, cards on phones), not tables, so a column header with
 * `aria-sort` does not exist; the sort is a toolbar of toggle buttons whose accessible name says the order
 * ("Ad, artan"), with a polite line after it. Same behaviour as the classic table: a new key starts ascending, the
 * same key flips, a third press goes back to the default order; the classic comparators; the loaded rows are sorted
 * in the browser. Unlike the classic table the choice is kept in the URL (`?sort=<key>&dir=asc|desc`, or a prefix for
 * a second list on the screen: `?<prefix>Sort=`), so a sorted list can be linked and survives a refresh.
 */

export type SortDir = 'asc' | 'desc';

export interface SortSpec<K extends string> {
  readonly key: K;
  readonly dir: SortDir;
}

function paramNames(prefix?: string): { readonly sort: string; readonly dir: string } {
  return prefix === undefined || prefix === ''
    ? { sort: 'sort', dir: 'dir' }
    : { sort: `${prefix}Sort`, dir: `${prefix}Dir` }; // i18n-ignore: URL parameter names
}

/** The sort in `params` (null = the default order), or `initial` when the URL names none. */
export function sortFrom<K extends string>(
  params: URLSearchParams,
  keys: readonly K[],
  opts: { readonly prefix?: string | undefined; readonly initial?: SortSpec<K> | null | undefined } = {},
): SortSpec<K> | null {
  const n = paramNames(opts.prefix);
  const raw = params.get(n.sort);
  if (raw === 'none') return null;
  const key = keys.find((k) => k === raw);
  if (key === undefined) return opts.initial ?? null;
  return { key, dir: params.get(n.dir) === 'desc' ? 'desc' : 'asc' };
}

/** A copy of `prev` with `s` written (`none` keeps "no sort" distinct from the initial sort). */
export function withSortParam<K extends string>(
  prev: URLSearchParams,
  s: SortSpec<K> | null,
  opts: { readonly prefix?: string | undefined; readonly initial?: SortSpec<K> | null | undefined } = {},
): URLSearchParams {
  const n = paramNames(opts.prefix);
  const next = new URLSearchParams(prev);
  const initial = opts.initial ?? null;
  if (s === null) {
    if (initial === null) next.delete(n.sort);
    else next.set(n.sort, 'none');
    next.delete(n.dir);
  } else if (initial !== null && s.key === initial.key && s.dir === initial.dir) {
    next.delete(n.sort);
    next.delete(n.dir);
  } else {
    next.set(n.sort, s.key);
    next.set(n.dir, s.dir);
  }
  return next;
}

/** Next sort after pressing a key: a new key starts ascending, the same one flips, a third press clears. */
export function nextSortSpec<K extends string>(cur: SortSpec<K> | null, key: K): SortSpec<K> | null {
  if (cur?.key !== key) return { key, dir: 'asc' };
  return cur.dir === 'asc' ? { key, dir: 'desc' } : null;
}

/** The rows in the chosen order (stable; descending = the ascending order reversed, as the classic table). */
export function sortRows<T, K extends string>(
  rows: readonly T[],
  s: SortSpec<K> | null,
  compare: Readonly<Record<K, (a: T, b: T) => number>>,
): readonly T[] {
  if (s === null) return rows;
  const out = [...rows].sort(compare[s.key]);
  return s.dir === 'desc' ? out.reverse() : out;
}

/** URL-kept sort for a list: `[sort, setSort]` (history replace, so sorting never piles up entries). */
export function useSortParam<K extends string>(
  keys: readonly K[],
  opts: { readonly prefix?: string | undefined; readonly initial?: SortSpec<K> | null | undefined } = {},
): readonly [SortSpec<K> | null, (s: SortSpec<K> | null) => void] {
  const [params, setParams] = useSearchParams();
  const read = sortFrom(params, keys, opts);
  // The same object while the key and direction stay: lists memoise their rows on it, and an inline `initial` is a
  // new object every render (p19-sort-stable: the projects list re-read every project's machines in a loop).
  const key = read?.key ?? null;
  const dir = read?.dir ?? null;
  const sort = useMemo(() => (key === null || dir === null ? null : { key, dir }), [key, dir]);
  const set = (s: SortSpec<K> | null): void => {
    setParams((prev) => withSortParam(prev, s, opts), { replace: true });
  };
  return [sort, set] as const;
}

/** The sort toolbar: one toggle per key (`aria-pressed`, the order in its name), the default-order note after it. */
export function DySortBar<K extends string>(props: {
  readonly keys: readonly K[];
  readonly labels: Readonly<Record<K, string>>;
  readonly sort: SortSpec<K> | null;
  readonly onSort: (s: SortSpec<K> | null) => void;
  /** Said while nothing is chosen ("Sunucu sırası: en yeni önce"). */
  readonly defaultNote?: string | undefined;
  /** Said while a key is chosen (default "Yüklenen satırlar sıralı"). */
  readonly sortedNote?: string | undefined;
  readonly testId?: string | undefined;
  readonly noteTestId?: string | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  const { sort } = props;
  const t = useT().shared.sort;
  return (
    <div className={cx('flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 py-2', props.className)}>
      <div
        role="group"
        aria-label={t.label}
        className="flex flex-wrap items-center gap-1"
        data-testid={props.testId}
      >
        <span className="mr-1 text-[0.8125rem] font-bold text-dy-muted" aria-hidden="true">
          {t.label}
        </span>
        {props.keys.map((k) => {
          const active = sort?.key === k;
          const dir = active ? sort.dir : null;
          return (
            <button
              key={k}
              type="button"
              aria-pressed={active}
              aria-label={
                dir === null
                  ? props.labels[k]
                  : dir === 'asc'
                    ? t.ascending({ label: props.labels[k] })
                    : t.descending({ label: props.labels[k] })
              }
              data-sort={k}
              data-dir={dir ?? undefined}
              onClick={() => {
                props.onSort(nextSortSpec(sort, k));
              }}
              className={
                active
                  ? 'dy-press inline-flex min-h-10 items-center gap-1 rounded-[8px] bg-dy-sunk px-2.5 text-[0.8125rem] font-bold text-dy-ink sm:min-h-8'
                  : 'dy-press inline-flex min-h-10 items-center gap-1 rounded-[8px] px-2.5 text-[0.8125rem] text-dy-muted sm:min-h-8 [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink'
              }
            >
              {props.labels[k]}
              {dir === null ? null : (
                <DyIcon name="chev" className={dir === 'asc' ? 'size-3.5 rotate-180' : 'size-3.5'} />
              )}
            </button>
          );
        })}
      </div>
      <span className="text-[0.75rem] text-dy-faint" aria-live="polite" data-testid={props.noteTestId}>
        {sort === null ? (props.defaultNote ?? t.defaultNote) : (props.sortedNote ?? t.sortedNote)}
      </span>
    </div>
  );
}
