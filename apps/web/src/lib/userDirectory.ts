import { useEffect, useState } from 'react';
import { listUsers } from '../api/directory';

/**
 * p6-ui-refactor "People, not UUIDs": user id → username, from GET /users (src/api/directory.ts). One request
 * per 5 minutes for the whole tab, shared by every <Actor />. /users is owner/admin only (`users.read`): for
 * everyone else (403) and on any failure the map stays empty and callers fall back to a short id — background
 * lookups never surface errors or sign anyone out.
 */
const TTL_MS = 5 * 60_000;

let cache: { at: number; value: Promise<ReadonlyMap<string, string>> } | null = null;

export function loadUserDirectory(now = Date.now()): Promise<ReadonlyMap<string, string>> {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  const value = listUsers()
    .then((users) => new Map(users.map((u) => [u.id, u.username] as const)) as ReadonlyMap<string, string>)
    .catch(() => new Map<string, string>() as ReadonlyMap<string, string>);
  cache = { at: now, value };
  return value;
}

/** Drops the cached directory (tests; after a user was created or renamed). */
export function resetUserDirectory(): void {
  cache = null;
}

/**
 * The username for `id` once the directory has loaded; undefined while loading or when unknown. `canRead`
 * false (operators and viewers cannot read /users) skips the request altogether.
 */
export function useUsername(id: string | null | undefined, canRead = true): string | undefined {
  const [name, setName] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (id === null || id === undefined || id === '' || !canRead) return;
    let live = true;
    void loadUserDirectory().then((m) => {
      if (live) setName(m.get(id));
    });
    return () => {
      live = false;
    };
  }, [id, canRead]);
  return name;
}
