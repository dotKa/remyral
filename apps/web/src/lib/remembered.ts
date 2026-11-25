import { useCallback, useState } from 'react';

/**
 * p14-web-perf (docs/design/p14-web-perf.md §4): the last answer a screen showed, kept in memory for the tab, so a
 * screen the user comes back to renders its previous data at once and refreshes it in the background
 * (stale-while-revalidate) instead of showing its skeleton again.
 *
 * - In memory only (never localStorage / Cache Storage): nothing survives a reload, nothing is written to disk.
 * - Cleared whenever the signed-in user changes or signs out (auth/AuthProvider.tsx), so one user never sees
 *   another user's data in a shared tab.
 * - It never replaces the fetch: every screen still loads on mount and keeps polling as before; this only decides
 *   what is on screen until that answer is there.
 */
const store = new Map<string, unknown>();
/** Bounded: the oldest entries go first (Map keeps insertion order; a write moves the key to the end). */
const MAX_ENTRIES = 200;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names what it stored
export function remembered<T>(key: string): T | undefined {
  return store.get(key) as T | undefined;
}

export function remember(key: string, value: unknown): void {
  store.delete(key);
  store.set(key, value);
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function forgetRemembered(): void {
  store.clear();
}

/**
 * `useState` that starts from the remembered value of `key` and remembers every value set through it.
 * Pass `key = null` to opt out (e.g. no user yet).
 */
export function useRememberedState<T>(
  key: string | null,
  initial: T,
): readonly [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => (key === null ? initial : (remembered<T>(key) ?? initial)));
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        if (key !== null) remember(key, v);
        return v;
      });
    },
    [key],
  );
  return [value, set] as const;
}
