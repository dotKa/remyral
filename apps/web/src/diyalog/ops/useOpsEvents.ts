import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getApproval } from '../../api/approvals';
import { ApiError } from '../../api/client';
import { useErrorText } from '../../i18n/errors';
import { getOpsAction } from '../../api/deploy';
import { markRead } from '../../api/notifications';
import { getOpsThread, type OpenCounts, type OpsItem } from '../../api/opsThread';
import { onInvalidate } from '../../lib/invalidate';
import { remember, remembered } from '../../lib/remembered';

/**
 * p12-diyalog Faz 1: the system side of the operations thread — `GET /ops-thread` pages kept as one map by item id
 * (a poll, a reconnect or an older page never adds a second copy of a card), newest page polled while the tab is
 * visible and at once on an approval / machine change, older pages on demand.
 *
 * Open cards that leave the open set without a notification behind them (a viewer's approval decided elsewhere) are
 * re-read once so they collapse to their outcome instead of standing as a stale "waiting" card.
 */
export const OPS_POLL_MS = 10_000;
const PAGE = 50;

export interface OpsEvents {
  readonly status: 'loading' | 'ready' | 'error' | 'off';
  readonly error: string | null;
  /** Oldest first (thread order). */
  readonly items: readonly OpsItem[];
  readonly open: OpenCounts | null;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  readonly loadOlder: () => void;
  readonly refresh: () => void;
  /** A card was decided here: show the new state at once (the next poll confirms it). */
  readonly patch: (item: OpsItem) => void;
  /** Notification ids seen on screen: marked read on the master (bell + unread markers follow). */
  readonly seen: (ids: readonly string[]) => void;
}

function sortOldestFirst(items: Iterable<OpsItem>): OpsItem[] {
  return [...items].sort((a, b) => {
    const t = Date.parse(a.at) - Date.parse(b.at);
    if (t !== 0) return t;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

async function reread(item: OpsItem): Promise<OpsItem | null> {
  try {
    if (item.type === 'approval:request')
      return { ...item, approval: (await getApproval(item.approval.id)).request };
    if (item.type === 'deploy:action') return { ...item, deploy: await getOpsAction(item.deploy.id) };
  } catch {
    // Not readable any more (access changed, removed): the card goes.
  }
  return null;
}

/** p14-web-perf: what the home showed last (lib/remembered.ts) — a revisit draws it at once, the poll refreshes it. */
interface Snapshot {
  readonly items: readonly OpsItem[];
  readonly openIds: readonly string[];
  readonly open: OpenCounts | null;
  readonly cursor: string | null;
}
const SNAPSHOT_KEY = 'ops-events';

/** Same content (the master's JSON): keeps the previous object, so an unchanged poll re-renders nothing. */
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Puts an item into the map; false when the map already held exactly this. */
function put(map: Map<string, OpsItem>, item: OpsItem): boolean {
  const prev = map.get(item.id);
  if (prev !== undefined && same(prev, item)) return false;
  map.set(item.id, item);
  return true;
}

export function useOpsEvents(): OpsEvents {
  const sayError = useErrorText();
  const [snapshot] = useState(() => remembered<Snapshot>(SNAPSHOT_KEY));
  const map = useRef(new Map<string, OpsItem>(snapshot?.items.map((i) => [i.id, i] as const) ?? []));
  const openIds = useRef(new Set<string>(snapshot?.openIds ?? []));
  const marked = useRef(new Set<string>());
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<OpsEvents['status']>(snapshot === undefined ? 'loading' : 'ready');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpenState] = useState<OpenCounts | null>(snapshot?.open ?? null);
  const [cursor, setCursor] = useState<string | null>(snapshot?.cursor ?? null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const firstLoaded = useRef(snapshot !== undefined);
  const inFlight = useRef(false);
  const latest = useRef({ open, cursor });
  latest.current = { open, cursor };

  const setOpen = useCallback((next: OpenCounts | null) => {
    setOpenState((prev) => (same(prev, next) ? prev : next));
  }, []);

  const bump = (): void => {
    setVersion((v) => v + 1);
  };

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const page = await getOpsThread({ limit: PAGE });
      const seenNow = new Set(page.items.map((i) => i.id));
      let changed = false;
      for (const item of page.items) if (put(map.current, item)) changed = true;
      // Open-only cards that vanished from the open set: re-read (approval / deploy) or drop.
      const gone = [...openIds.current].filter((id) => !seenNow.has(id));
      openIds.current = new Set(
        page.items.filter((i) => i.event === null && i.type !== 'event').map((i) => i.id),
      );
      // p14-web-perf: the re-reads run in parallel (they are independent), not one after the other.
      const stale = gone.flatMap((id) => {
        const prev = map.current.get(id);
        return prev === undefined || prev.event !== null ? [] : [prev];
      });
      const rereads = await Promise.all(stale.map(async (prev) => [prev.id, await reread(prev)] as const));
      for (const [id, next] of rereads) {
        if (next === null) {
          map.current.delete(id);
          changed = true;
        } else if (put(map.current, next)) changed = true;
      }
      let nextCursor = latest.current.cursor;
      if (!firstLoaded.current) {
        firstLoaded.current = true;
        nextCursor = page.nextCursor;
        setCursor(page.nextCursor);
      }
      setOpen(page.open);
      setStatus('ready');
      setError(null);
      remember(SNAPSHOT_KEY, {
        items: [...map.current.values()],
        openIds: [...openIds.current],
        open: page.open,
        cursor: nextCursor,
      } satisfies Snapshot);
      // p14-web-perf: an unchanged poll (the common case, every 10 s) re-renders nothing.
      if (changed) bump();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
        // An older master without the endpoint, or no access: the thread shows the chat only.
        setStatus('off');
      } else {
        setStatus((s) => (s === 'ready' ? s : 'error'));
        setError(err instanceof ApiError ? sayError(err) : err instanceof Error ? err.message : String(err));
      }
    } finally {
      inFlight.current = false;
    }
  }, [sayError]);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, OPS_POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    const off = onInvalidate(['approvals', 'workers'], () => {
      void load();
    });
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      off();
    };
  }, [load]);

  const loadOlder = useCallback(() => {
    if (cursor === null || loadingOlder) return;
    setLoadingOlder(true);
    getOpsThread({ before: cursor, limit: PAGE }).then(
      (page) => {
        for (const item of page.items) if (!map.current.has(item.id)) map.current.set(item.id, item);
        setCursor(page.nextCursor);
        setLoadingOlder(false);
        bump();
      },
      () => {
        setLoadingOlder(false);
      },
    );
  }, [cursor, loadingOlder]);

  const patch = useCallback((item: OpsItem) => {
    map.current.set(item.id, item);
    bump();
  }, []);

  const seen = useCallback((ids: readonly string[]) => {
    const fresh = ids.filter((id) => !marked.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) marked.current.add(id);
    void Promise.allSettled(fresh.map((id) => markRead(id))).then(() => {
      for (const [k, item] of map.current)
        if (item.event !== null && fresh.includes(item.event.notificationId))
          map.current.set(k, { ...item, unread: false });
      bump();
    });
  }, []);

  // `version` makes the derived list follow the map without copying it on every render.
  // The map is a ref; `version` says when it changed.
  const items = useMemo(() => sortOldestFirst(map.current.values()), [version]);

  return {
    status,
    error,
    items,
    open,
    hasOlder: cursor !== null,
    loadingOlder,
    loadOlder,
    refresh: () => void load(),
    patch,
    seen,
  };
}
