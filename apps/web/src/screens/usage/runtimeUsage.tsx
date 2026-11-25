import { useEffect, useReducer } from 'react';
import type { ApiError } from '../../api/client';
import { getUsageOverview, type UsageOverview } from '../../api/runtimeUsage';
import { toApiError } from '../../components/ui';

/**
 * p11-limit-visibility (docs/design/p11-limit-visibility.md §6): the runtimes' usage limits where work is decided —
 * the composer and the chat's job card (one compact line per runtime), the machine page (a card per runtime login with
 * a bar per window), the machine list (a badge), Home (a summary) and Usage → Enforcement (the full table with 24-hour
 * sparklines and the near-limit setting). One shared, polled overview per query keeps the requests few.
 */

// ---------------------------------------------------------------------------------------------------------------
// Shared, polled overview

interface CacheEntry {
  data: UsageOverview | null;
  error: ApiError | null;
  at: number;
  loading: Promise<void> | null;
  readonly subs: Set<() => void>;
}

const cache = new Map<string, CacheEntry>();
const FRESH_MS = 30_000;
const POLL_MS = 60_000;

/** Tests: forget the shared overview between renders. */
export function resetRuntimeUsageCache(): void {
  cache.clear();
}

/** p15-usage-refresh: load every shown overview again now (after "Şimdi kontrol et" read new numbers). */
export function reloadRuntimeUsage(): void {
  for (const key of [...cache.keys()]) load(key, { history: key === 'history' }, true);
}

function load(key: string, q: { history?: boolean }, force = false): void {
  let e = cache.get(key);
  if (e === undefined) {
    e = { data: null, error: null, at: 0, loading: null, subs: new Set() };
    cache.set(key, e);
  }
  const entry = e;
  if (entry.loading !== null || (!force && Date.now() - entry.at < FRESH_MS)) return;
  entry.loading = getUsageOverview(q)
    .then(
      (d) => {
        entry.data = d;
        entry.error = null;
      },
      (err: unknown) => {
        entry.error = toApiError(err);
      },
    )
    .finally(() => {
      entry.at = Date.now();
      entry.loading = null;
      for (const s of entry.subs) s();
    });
}

/** The overview (shared by every component on the page), refreshed every minute while shown. */
export function useRuntimeUsage(q: { readonly history?: boolean } = {}): {
  readonly data: UsageOverview | null;
  readonly error: ApiError | null;
} {
  const key = q.history === true ? 'history' : 'plain';
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    let e = cache.get(key);
    if (e === undefined) {
      e = { data: null, error: null, at: 0, loading: null, subs: new Set() };
      cache.set(key, e);
    }
    const entry = e;
    entry.subs.add(rerender);
    load(key, { history: q.history === true });
    const t = setInterval(() => {
      load(key, { history: q.history === true }, true);
    }, POLL_MS);
    return () => {
      entry.subs.delete(rerender);
      clearInterval(t);
    };
  }, [key]);
  const e = cache.get(key);
  return { data: e?.data ?? null, error: e?.error ?? null };
}
