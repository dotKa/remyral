import { useCallback, useEffect, useState } from 'react';
import { type AssetKind, type ChatAsset, listAssets } from '../../../api/chatOrganize';
import type { ApiError } from '../../../api/client';
import { toApiError } from '../../../components/ui';
import { onInvalidate } from '../../../lib/invalidate';

export const SIDEBAR_KEY_PREFIX = 'remyral.chat.sidebar.';
const JOBS_POLL_MS = 15_000;

function readOpen(userId: string): boolean {
  try {
    return window.localStorage.getItem(`${SIDEBAR_KEY_PREFIX}${userId}`) === 'open';
  } catch {
    return false;
  }
}

function writeOpen(userId: string, open: boolean): void {
  try {
    window.localStorage.setItem(`${SIDEBAR_KEY_PREFIX}${userId}`, open ? 'open' : 'closed');
  } catch {
    // Private mode / blocked storage: the choice just is not remembered.
  }
}

/** Open / closed, remembered per user (closed by default). */
export function useSidebarOpen(userId: string): readonly [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => readOpen(userId));
  useEffect(() => {
    setOpen(readOpen(userId));
  }, [userId]);
  const set = useCallback(
    (v: boolean) => {
      setOpen(v);
      writeOpen(userId, v);
    },
    [userId],
  );
  return [open, set] as const;
}

export const KIND_LABEL: Readonly<Record<string, string>> = {
  job: 'Job',
  workflow_run: 'Workflow run',
  automation: 'Automation',
  automation_change: 'Automation change',
  ops_action: 'Deploy',
  machine_task: 'Machine task',
  tool_install: 'Tool install',
  monitor: 'Monitor',
  job_resume: 'Resume',
  skill: 'Skill',
};

export function useAssets(
  kind: AssetKind,
  threadId: string | null,
  enabled: boolean,
): {
  items: ChatAsset[] | null;
  error: ApiError | null;
  next: string | null;
  more: boolean;
  loadMore: () => void;
} {
  const [items, setItems] = useState<ChatAsset[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const off = onInvalidate(['chat', 'chat-organize'], () => {
      setTick((n) => n + 1);
    });
    const timer =
      kind === 'jobs'
        ? setInterval(() => {
            if (document.visibilityState !== 'hidden') setTick((n) => n + 1);
          }, JOBS_POLL_MS)
        : null;
    return () => {
      off();
      if (timer !== null) clearInterval(timer);
    };
  }, [enabled, kind]);
  useEffect(() => {
    setItems(null);
    setNext(null);
  }, [kind, threadId]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    listAssets(kind, threadId).then(
      (page) => {
        if (!live) return;
        setItems(page.items);
        setNext(page.nextCursor);
        setError(null);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [kind, threadId, enabled, tick]);
  const loadMore = (): void => {
    if (next === null || more) return;
    setMore(true);
    listAssets(kind, threadId, next).then(
      (page) => {
        setItems((list) => {
          // Links are deduplicated per page by the master; across pages here (the newest message wins).
          const have = new Set((list ?? []).map((x) => x.key));
          return [...(list ?? []), ...page.items.filter((x) => !have.has(x.key))];
        });
        setNext(page.nextCursor);
        setMore(false);
      },
      (err: unknown) => {
        setError(toApiError(err));
        setMore(false);
      },
    );
  };
  return { items, error, next, more, loadMore };
}
