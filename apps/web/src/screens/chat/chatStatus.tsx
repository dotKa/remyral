import { useCallback, useEffect, useRef } from 'react';
import { type ChatStatus, markThreadRead } from '../../api/chat';
import { invalidate } from '../../lib/invalidate';

/** Where an unavailable assistant is fixed. */
export function statusFix(s: ChatStatus): { to: string; label: string } {
  // p11-usage-limit-fallback: an engine at its usage limit is fixed by a fallback engine in Settings → Chat.
  if (
    s.code === 'disabled' ||
    s.code === 'not_configured' ||
    s.code === 'engine_limited' ||
    s.worker === null
  ) {
    return { to: '/settings/chat', label: 'Settings → Chat' };
  }
  return {
    to: `/machines?worker=${encodeURIComponent(s.worker.id)}`,
    label: `Open ${s.worker.name} in Machines`,
  };
}

/** p9-chat-unread: the reader can see this tab (visible and focused). */
function pageInView(): boolean {
  return (
    document.visibilityState === 'visible' && (typeof document.hasFocus !== 'function' || document.hasFocus())
  );
}

/**
 * p9-chat-unread: marks the open conversation read up to its newest loaded message — when it opens and whenever a
 * new message arrives while the tab is visible and focused; a tab in the background catches up when it becomes
 * visible / focused again (Page Visibility API). New messages it cannot mark yet still update the Chat badge and the
 * tab title (`invalidate('chat')`). A failed update is retried on the next chance; it never shows an error.
 */
export function useMarkRead(threadId: string, lastSeq: number | null): void {
  const marked = useRef(0);
  const seen = useRef<number | null>(null);
  const latest = useRef(lastSeq);
  latest.current = lastSeq;
  useEffect(() => {
    marked.current = 0;
    seen.current = null;
  }, [threadId]);
  const tryMark = useCallback(() => {
    const seq = latest.current;
    if (seq === null || seq <= 0 || seq <= marked.current || !pageInView()) return;
    const before = marked.current;
    marked.current = seq;
    markThreadRead(threadId, seq).then(
      () => {
        invalidate('chat');
      },
      () => {
        if (marked.current === seq) marked.current = before;
      },
    );
  }, [threadId]);
  useEffect(() => {
    if (lastSeq === null) return;
    const grew = seen.current !== null && lastSeq > seen.current;
    seen.current = lastSeq;
    if (pageInView()) tryMark();
    else if (grew) invalidate('chat');
  }, [lastSeq, tryMark]);
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') tryMark();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', tryMark);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', tryMark);
    };
  }, [tryMark]);
}
