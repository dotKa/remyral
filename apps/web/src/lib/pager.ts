import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import type { ApiError } from '../api/client';
import { toApiError } from '../components/ui';
import { remember, remembered } from './remembered';

/**
 * URL-synced paging for list screens (p9-pagination, docs/design/p9-pagination.md §4).
 *
 * The position lives in the query string so a page can be linked, reloaded and stepped through with the browser's
 * back / forward buttons: `?page=3&pageSize=50` (offset and client-side lists) or `?cursor=…&page=3&pageSize=50`
 * (keyset lists; `page` is only the number shown). A screen with two lists gives each a prefix
 * (`?checksPage=2&checksPageSize=100`). Filters reset the position with `withoutPage` inside their own URL update,
 * so a new filter always starts on page 1; the page size is kept.
 *
 * Keyset lists cannot jump backwards on their own: the cursors of the pages before the current one travel in the
 * history entry's state, so "Previous" goes back one page; a reloaded or shared link without that state goes back
 * to page 1 instead.
 */

/** Page sizes offered everywhere (p9-pagination); the API accepts any size up to its cap. */
export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

export interface PaginationProps {
  /** Accessible name of the navigation, e.g. "Jobs pages". */
  readonly label: string;
  /** 1-based page number. */
  readonly page: number;
  readonly pageSize: number;
  /** Rows shown on this page. */
  readonly count: number;
  /** Rows in the whole list, when known (offset lists); unknown for keyset lists. */
  readonly total?: number | null | undefined;
  readonly hasNext: boolean;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  /** Jump to page 1 (shown from page 3 on). */
  readonly onFirst?: (() => void) | undefined;
  /** Jump to the last page (offset lists with a known total). */
  readonly onLast?: (() => void) | undefined;
  readonly onPageSize: (size: number) => void;
  /** A page is loading: the buttons wait. */
  readonly busy?: boolean | undefined;
  readonly className?: string | undefined;
  readonly 'data-testid'?: string;
}

export interface PageKeys {
  readonly page: string;
  readonly size: string;
  readonly cursor: string;
}

export function pageKeys(prefix?: string): PageKeys {
  return prefix
    ? { page: `${prefix}Page`, size: `${prefix}PageSize`, cursor: `${prefix}Cursor` }
    : { page: 'page', size: 'pageSize', cursor: 'cursor' };
}

/** A copy of `params` without the page position (page number and cursor) of `prefix`; the page size stays. */
export function withoutPage(params: URLSearchParams, prefix?: string): URLSearchParams {
  const k = pageKeys(prefix);
  const next = new URLSearchParams(params);
  next.delete(k.page);
  next.delete(k.cursor);
  return next;
}

function parseSize(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : fallback;
}

function parsePage(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : 1;
}

/** Earlier pages' cursors in `history.state` (index i: the cursor of page i + 1; page 1 has none). */
type Stacks = Readonly<Record<string, readonly (string | null)[]>>;

function stacksOf(state: unknown): Stacks {
  if (typeof state !== 'object' || state === null) return {};
  const s = (state as { pagerStacks?: unknown }).pagerStacks;
  return typeof s === 'object' && s !== null ? (s as Stacks) : {};
}

export interface PageParams {
  readonly page: number;
  readonly pageSize: number;
  readonly cursor: string | null;
  /** Offset lists: go to a page (pushes a history entry). */
  readonly goPage: (page: number) => void;
  /** Keyset lists: the next page after `nextCursor`. */
  readonly goNext: (nextCursor: string) => void;
  /** Keyset lists: one page back (page 1 when the earlier cursors are not known). */
  readonly goPrev: () => void;
  readonly goFirst: () => void;
  readonly setPageSize: (size: number) => void;
}

export function usePageParams(
  opts: { readonly prefix?: string; readonly defaultSize?: number } = {},
): PageParams {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const k = pageKeys(opts.prefix);
  const page = parsePage(params.get(k.page));
  const pageSize = parseSize(params.get(k.size), opts.defaultSize ?? DEFAULT_PAGE_SIZE);
  const cursorRaw = params.get(k.cursor);
  const cursor = cursorRaw === null || cursorRaw === '' ? null : cursorRaw;
  const stackKey = opts.prefix ?? '';
  const stacks = stacksOf(location.state);

  const push = useCallback(
    (mutate: (p: URLSearchParams) => void, stack: readonly (string | null)[] | null) => {
      const next = new URLSearchParams(params);
      mutate(next);
      const qs = next.toString();
      const prev = (
        typeof location.state === 'object' && location.state !== null ? location.state : {}
      ) as object;
      const nextStacks: Record<string, readonly (string | null)[]> = Object.fromEntries(
        Object.entries(stacksOf(location.state)).filter(([key]) => key !== stackKey),
      );
      if (stack !== null) nextStacks[stackKey] = stack;
      void navigate(
        { pathname: location.pathname, search: qs === '' ? '' : `?${qs}`, hash: location.hash },
        { state: { ...prev, pagerStacks: nextStacks } },
      );
    },
    [params, location.pathname, location.hash, location.state, navigate, stackKey],
  );

  const goPage = useCallback(
    (p: number) => {
      push((n) => {
        if (p <= 1) n.delete(k.page);
        else n.set(k.page, String(p));
        n.delete(k.cursor);
      }, null);
    },
    [push, k.page, k.cursor],
  );

  const atStart = page === 1 && cursor === null;
  const goFirst = useCallback(() => {
    if (atStart) return;
    push((n) => {
      n.delete(k.page);
      n.delete(k.cursor);
    }, null);
  }, [atStart, push, k.page, k.cursor]);

  const goNext = useCallback(
    (nextCursor: string) => {
      // The cursors of pages 1..page (page 1: none). Only kept when the earlier ones are known: a page opened
      // from a link has no history, and "Previous" from there returns to page 1.
      const known = stacks[stackKey];
      const stack =
        page === 1 ? [null] : known !== undefined && known.length === page - 1 ? [...known, cursor] : null;
      push((n) => {
        n.set(k.cursor, nextCursor);
        n.set(k.page, String(page + 1));
      }, stack);
    },
    [push, stacks, stackKey, page, cursor, k.cursor, k.page],
  );

  const goPrev = useCallback(() => {
    const known = stacks[stackKey];
    const target = page - 1;
    if (target <= 1 || known === undefined || known.length !== page - 1) {
      goFirst();
      return;
    }
    const prevCursor = known[target - 1] ?? null;
    push(
      (n) => {
        if (prevCursor === null) n.delete(k.cursor);
        else n.set(k.cursor, prevCursor);
        n.set(k.page, String(target));
      },
      known.slice(0, target - 1),
    );
  }, [stacks, stackKey, page, goFirst, push, k.cursor, k.page]);

  const setPageSize = useCallback(
    (size: number) => {
      const s = PAGE_SIZES.includes(size as (typeof PAGE_SIZES)[number]) ? size : DEFAULT_PAGE_SIZE;
      setParams(
        (prev) => {
          const n = withoutPage(prev, opts.prefix);
          if (s === (opts.defaultSize ?? DEFAULT_PAGE_SIZE)) n.delete(k.size);
          else n.set(k.size, String(s));
          return n;
        },
        { replace: true },
      );
    },
    [setParams, opts.prefix, opts.defaultSize, k.size],
  );

  return { page, pageSize, cursor, goPage, goNext, goPrev, goFirst, setPageSize };
}

/**
 * Client-side pages over a list the screen already has in full (bounded admin lists: users, projects, machines,
 * templates, …; they are filtered and searched in the browser).
 */
export function useClientPage<T>(
  items: readonly T[],
  opts: { readonly label: string; readonly prefix?: string; readonly defaultSize?: number },
): { readonly pageItems: readonly T[]; readonly pagination: PaginationProps } {
  const pp = usePageParams(opts);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pp.pageSize));
  const page = Math.min(pp.page, pages);
  const start = (page - 1) * pp.pageSize;
  const pageItems = useMemo(() => items.slice(start, start + pp.pageSize), [items, start, pp.pageSize]);
  return {
    pageItems,
    pagination: {
      label: opts.label,
      page,
      pageSize: pp.pageSize,
      count: pageItems.length,
      total,
      hasNext: page < pages,
      onPrev: () => {
        pp.goPage(page - 1);
      },
      onNext: () => {
        pp.goPage(page + 1);
      },
      onFirst: () => {
        pp.goPage(1);
      },
      onLast: () => {
        pp.goPage(pages);
      },
      onPageSize: pp.setPageSize,
    },
  };
}

export interface ServerList<T> {
  readonly items: readonly T[];
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly error: ApiError | null;
  readonly reload: () => void;
  /** Back to page 1 (for filters kept in component state rather than the URL). */
  readonly reset: () => void;
  readonly pagination: PaginationProps;
}

interface ListState<T> {
  readonly items: readonly T[];
  readonly next: string | null;
  readonly total: number | null;
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly error: ApiError | null;
}

const EMPTY = { items: [], next: null, total: null, loading: true, loaded: false, error: null } as const;

/**
 * A keyset (cursor) list read page by page from the API. `key` identifies the filters: a new key re-reads.
 * With `refreshMs`, the first page re-reads itself while the tab is visible (new rows appear at the top).
 */
export function useCursorList<T>(opts: {
  readonly key: string;
  readonly label: string;
  readonly prefix?: string;
  readonly defaultSize?: number;
  readonly refreshMs?: number;
  /**
   * p14-web-perf: remember the pages under this name (lib/remembered.ts): coming back to the list shows the last
   * answer for the same filters and position at once (still re-read, marked `loading`) instead of the skeleton.
   */
  readonly remember?: string;
  readonly fetchPage: (
    cursor: string | null,
    limit: number,
  ) => Promise<{ readonly items: readonly T[]; readonly nextCursor: string | null }>;
}): ServerList<T> {
  const pp = usePageParams(opts);
  const memoryKey =
    opts.remember === undefined
      ? null
      : `list:${opts.remember}:${opts.key}:${pp.cursor ?? ''}:${String(pp.pageSize)}`;
  const [state, setState] = useState<ListState<T>>(() => {
    const last = memoryKey === null ? undefined : remembered<ListState<T>>(memoryKey);
    return last === undefined ? EMPTY : { ...last, loading: true };
  });
  const memoryRef = useRef(memoryKey);
  memoryRef.current = memoryKey;
  const [tick, setTick] = useState(0);
  const fetchRef = useRef(opts.fetchPage);
  fetchRef.current = opts.fetchPage;
  const { cursor, pageSize, page, goFirst } = pp;

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchRef.current(cursor, pageSize).then(
      (p) => {
        if (!live) return;
        const next: ListState<T> = {
          items: p.items,
          next: p.nextCursor,
          total: null,
          loading: false,
          loaded: true,
          error: null,
        };
        setState(next);
        if (memoryRef.current !== null) remember(memoryRef.current, next);
      },
      (err: unknown) => {
        if (!live) return;
        const e = toApiError(err);
        // A cursor that no longer fits the list (other filters, an old link): start again from page 1.
        if (cursor !== null && e.code === 'invalid_cursor') {
          goFirst();
          return;
        }
        setState({ items: [], next: null, total: null, loading: false, loaded: true, error: e });
      },
    );
    return () => {
      live = false;
    };
    // goFirst changes with the URL; the request only depends on the position and the filters.
  }, [opts.key, cursor, pageSize, tick]);

  const refreshMs = opts.refreshMs;
  useEffect(() => {
    if (refreshMs === undefined || cursor !== null) return;
    let live = true;
    const t = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      fetchRef.current(null, pageSize).then(
        (p) => {
          if (!live) return;
          setState((s) => {
            if (!s.loaded || s.error) return s;
            const next = { ...s, items: p.items, next: p.nextCursor };
            if (memoryRef.current !== null) remember(memoryRef.current, next);
            return next;
          });
        },
        () => undefined,
      );
    }, refreshMs);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [refreshMs, cursor, pageSize, opts.key]);

  const reload = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  const next = state.next;
  return {
    items: state.items,
    loading: state.loading,
    loaded: state.loaded,
    error: state.error,
    reload,
    reset: pp.goFirst,
    pagination: {
      label: opts.label,
      page,
      pageSize,
      count: state.items.length,
      total: null,
      hasNext: next !== null,
      busy: state.loading,
      onPrev: pp.goPrev,
      onNext: () => {
        if (next !== null) pp.goNext(next);
      },
      onFirst: pp.goFirst,
      onPageSize: pp.setPageSize,
    },
  };
}

/** An offset list read page by page from the API, with its total (`?page=` in the URL). */
export function useOffsetList<T>(opts: {
  readonly key: string;
  readonly label: string;
  readonly prefix?: string;
  readonly defaultSize?: number;
  readonly fetchPage: (
    offset: number,
    limit: number,
  ) => Promise<{ readonly items: readonly T[]; readonly total: number }>;
}): ServerList<T> {
  const pp = usePageParams(opts);
  const [state, setState] = useState<ListState<T>>(EMPTY);
  const [tick, setTick] = useState(0);
  const fetchRef = useRef(opts.fetchPage);
  fetchRef.current = opts.fetchPage;
  const { page, pageSize } = pp;

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchRef.current((page - 1) * pageSize, pageSize).then(
      (p) => {
        if (live)
          setState({ items: p.items, next: null, total: p.total, loading: false, loaded: true, error: null });
      },
      (err: unknown) => {
        if (live)
          setState({
            items: [],
            next: null,
            total: null,
            loading: false,
            loaded: true,
            error: toApiError(err),
          });
      },
    );
    return () => {
      live = false;
    };
  }, [opts.key, page, pageSize, tick]);

  const reload = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  const total = state.total;
  const pages = total === null ? page : Math.max(1, Math.ceil(total / pageSize));
  return {
    items: state.items,
    loading: state.loading,
    loaded: state.loaded,
    error: state.error,
    reload,
    reset: pp.goFirst,
    pagination: {
      label: opts.label,
      page,
      pageSize,
      count: state.items.length,
      total,
      hasNext: page < pages,
      busy: state.loading,
      onPrev: () => {
        pp.goPage(Math.min(page - 1, pages));
      },
      onNext: () => {
        pp.goPage(page + 1);
      },
      onFirst: () => {
        pp.goPage(1);
      },
      onLast: () => {
        pp.goPage(pages);
      },
      onPageSize: pp.setPageSize,
    },
  };
}
