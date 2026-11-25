import { useSyncExternalStore } from 'react';

/**
 * p5-live-fixes-2: one shared clock for relative timestamps ("2 minutes ago"). Without it a relative time
 * is computed once per render and freezes while the page stays open. One interval serves every
 * subscriber and stops when the last one unmounts; a tab that becomes visible again ticks at once.
 */

export const NOW_TICK_MS = 30_000;

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  now = Date.now();
  for (const l of listeners) l();
}

function onVisible(): void {
  if (document.visibilityState === 'visible') tick();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(tick, NOW_TICK_MS);
    document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

function snapshot(): number {
  return now;
}

/** The current time, re-rendering the caller every `NOW_TICK_MS` (and when the tab becomes visible). */
export function useNow(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
