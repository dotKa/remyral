import { useEffect, useState } from 'react';
import { listWorkers } from '../api/workers';
import { onInvalidate } from './invalidate';

/**
 * p6-ui-jobs "machines, not ids": worker id → display name, from GET /workers (the same request the fleet
 * list makes). One request per minute for the whole tab, shared by every caller; on any failure the map
 * stays empty and callers fall back to a short id — a background lookup never surfaces an error.
 */
const TTL_MS = 60_000;

let cache: { at: number; value: Promise<ReadonlyMap<string, string>> } | null = null;

export function loadMachineDirectory(now = Date.now()): Promise<ReadonlyMap<string, string>> {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  const value = listWorkers()
    .then((ws) => new Map(ws.map((w) => [w.id, w.name] as const)) as ReadonlyMap<string, string>)
    .catch(() => new Map<string, string>() as ReadonlyMap<string, string>);
  cache = { at: now, value };
  return value;
}

/** Drops the cached directory (tests). */
export function resetMachineDirectory(): void {
  cache = null;
}

const EMPTY: ReadonlyMap<string, string> = new Map();

/** Every known machine name by worker id (empty while loading or when the list cannot be read). */
export function useMachineNames(): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(EMPTY);
  useEffect(() => {
    let live = true;
    const load = (): void => {
      void loadMachineDirectory().then((m) => {
        if (live) setNames(m);
      });
    };
    load();
    // p15-chat-cards-scroll: a machine was renamed (or paired, removed): every shown name follows at once. The first
    // listener drops the cache; the others in the same event share the new request.
    const off = onInvalidate(['workers'], () => {
      if (cache !== null && Date.now() - cache.at > 50) cache = null;
      load();
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return names;
}

/** The machine's name, or the first 8 characters of an unknown id. */
export function machineName(names: ReadonlyMap<string, string>, id: string): string {
  return names.get(id) ?? (id.length > 12 ? id.slice(0, 8) : id);
}
