import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type ChatMessage, readPosition } from '../../api/chat';
import { FOLLOW_PX, followAfterScroll, watchScrollIntent } from '../../lib/scrollIntent';

/**
 * p12-chat-scroll-anchor (docs/design/p12-diyalog.md §18): where the Sohbet thread opens and how it stays there.
 *
 * Opening a conversation: a `?m=` jump wins; else the first unread answer sits at the top of the visible thread area
 * (under the sticky header) with the "Okunmamış mesajlar" divider above it; else the place the reader left this
 * conversation in this session; else the very bottom. The position is set in a layout effect after the rows are
 * rendered, so the first paint is already there. Until the reader scrolls (wheel, touch, pointer, key, or a scroll
 * the anchor did not make), the spot is kept while the content changes height (images, code blocks, badges, fonts,
 * the viewport): every resize of the thread re-applies it.
 *
 * The Sohbet scrolls the window (as every Diyalog thread does), so all positions here are window positions.
 *
 * p15-chat-cards-scroll item 3 (the reader may be reading while an answer streams): new content (an answer being
 * written, a new message) is followed only while the reader is at the end (within FOLLOW_PX). The moment the reader
 * scrolls up — a wheel turned up, or an upward scroll right after their own input — following stops, even a few pixels
 * from the end, and the screen shows "Yeni içerik ↓" instead; back at the end, it follows again.
 */

export type ScrollSpot =
  | { readonly kind: 'bottom' }
  /** The row `key` with its top `offset` px below the sticky header's lower edge. */
  | { readonly kind: 'item'; readonly key: string; readonly offset: number };

/** A reader this close to the end counts as "at the bottom" (follows new messages). */
export const NEAR_BOTTOM_PX = 240;
/** The first unread row sits this far under the header, so the divider above it is not glued to the header. */
export const UNREAD_GAP_PX = 8;
/** Waiting longer than this for the read position opens the conversation without the unread anchor. */
export const READ_POSITION_TIMEOUT_MS = 2_000;

// Per-conversation scroll memory for this browser session (the SPA keeps the module alive across conversations).
const memory = new Map<string, ScrollSpot>();

export function rememberedSpot(threadId: string): ScrollSpot | undefined {
  return memory.get(threadId);
}

/** Tests: forget every remembered position. */
export function resetScrollMemory(): void {
  memory.clear();
}

export function nearBottom(): boolean {
  const doc = document.documentElement;
  return window.innerHeight + window.scrollY >= doc.scrollHeight - NEAR_BOTTOM_PX;
}

/** How far the window is from the end of the page. */
export function distanceToEnd(): number {
  return Math.max(0, document.documentElement.scrollHeight - window.innerHeight - window.scrollY);
}

/** The reader is at the end (follows new content; the "Yeni içerik" pill goes away). */
export function atEnd(): boolean {
  return distanceToEnd() <= FOLLOW_PX;
}

function scrollWindow(top: number): void {
  if (typeof window.scrollTo === 'function') window.scrollTo({ top, behavior: 'instant' });
}

export function scrollToEnd(): void {
  scrollWindow(document.documentElement.scrollHeight);
}

/** The thread row key (`m:<id>`, timeline.ts) of the first unread answer or error after `lastReadSeq`, or null. */
export function firstUnreadKey(messages: readonly ChatMessage[], lastReadSeq: number | null): string | null {
  if (lastReadSeq === null) return null;
  // The master counts answers and errors as unread (p9-chat-unread); the reader's own messages never are.
  const m = messages.find((x) => x.seq > lastReadSeq && (x.role === 'assistant' || x.role === 'error'));
  return m === undefined ? null : `m:${m.id}`;
}

/**
 * The height covered at the top of the window by sticky / fixed bars marked `data-dy-sticky` (the Sohbet header,
 * the knowledge strip from 768 px, the standalone top bar): the visible thread area starts under it.
 */
export function stickyInset(): number {
  let inset = 0;
  for (const el of document.querySelectorAll<HTMLElement>('[data-dy-sticky]')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'sticky' && cs.position !== 'fixed') continue;
    const top = Number.parseFloat(cs.top);
    inset = Math.max(inset, (Number.isFinite(top) ? top : 0) + el.getBoundingClientRect().height);
  }
  return inset;
}

function rowOf(root: HTMLElement | null, key: string): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) ?? null;
}

/** Where the window must be scrolled to for `spot`, or null when its row is not rendered. */
function targetTop(spot: ScrollSpot, root: HTMLElement | null): number | null {
  if (spot.kind === 'bottom') return document.documentElement.scrollHeight;
  const row = rowOf(root, spot.key);
  if (row === null) return null;
  return Math.max(0, window.scrollY + row.getBoundingClientRect().top - stickyInset() - spot.offset);
}

/** The reader's place now: the bottom, or the first row under the header and how far below the header it starts. */
function currentSpot(root: HTMLElement | null): ScrollSpot | null {
  if (root === null) return null;
  if (nearBottom()) return { kind: 'bottom' };
  const inset = stickyInset();
  for (const row of root.querySelectorAll<HTMLElement>('[data-key]')) {
    const r = row.getBoundingClientRect();
    if (r.bottom > inset) return { kind: 'item', key: row.dataset.key ?? '', offset: r.top - inset };
  }
  return null;
}

/**
 * The caller's read position in `threadId`, read once per conversation before the screen's own read mark (null when
 * it cannot be read in time). `skip`: nothing to read (a new conversation, none, an error).
 */
export function useReadPosition(
  threadId: string | null,
  skip: boolean,
): { readonly done: boolean; readonly lastReadSeq: number | null } {
  const [got, setGot] = useState<{ readonly id: string; readonly seq: number | null } | null>(null);
  useEffect(() => {
    if (skip || threadId === null) return;
    let live = true;
    const settle = (seq: number | null): void => {
      // Latched: the first answer (or the timeout) decides for this conversation.
      if (live) setGot((cur) => (cur?.id === threadId ? cur : { id: threadId, seq }));
    };
    const timer = setTimeout(() => {
      settle(null);
    }, READ_POSITION_TIMEOUT_MS);
    readPosition(threadId).then(
      (r) => {
        settle(r.lastReadSeq);
      },
      () => {
        settle(null);
      },
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [threadId, skip]);
  if (skip) return { done: true, lastReadSeq: null };
  const done = got !== null && got.id === threadId;
  return { done, lastReadSeq: done ? got.seq : null };
}

export interface ScrollAnchor {
  /** The opening position has been set (the follow / "Yeni mesajlar" logic starts after it). */
  readonly positioned: boolean;
  /**
   * The opening position is being set: the thread lays every row out at its real height (`data-anchoring`, no
   * `content-visibility` skipping) until two frames after it, so it is measured on real sizes.
   */
  readonly settling: boolean;
  /**
   * The reader was at (or pinned to) the end before the latest change and has not scrolled up since: new content should
   * be followed.
   */
  readonly following: () => boolean;
  /** Go to the bottom and stay there while content settles (follow, "Yeni mesajlar"). */
  readonly toBottom: () => void;
  /** Stop holding any spot (a jump to a message takes over). */
  readonly release: () => void;
}

const USER_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

export function useScrollAnchor(opts: {
  /** The conversation (the memory key); null for a new one. */
  readonly threadId: string | null;
  /** The rows are rendered and the read position is known. */
  readonly ready: boolean;
  /** The first unread row's key, or null. */
  readonly unread: string | null;
  /** A jump to a message (`?m=`) runs on open: it positions the thread instead. */
  readonly jumping: boolean;
  /** The thread's rows (`[data-key]` items) live under this element. */
  readonly content: RefObject<HTMLElement | null>;
}): ScrollAnchor {
  const { content, threadId } = opts;
  const spot = useRef<ScrollSpot | null>(null);
  const expected = useRef<number | null>(null);
  const near = useRef(true);
  const done = useRef(false);
  const [positioned, setPositioned] = useState(false);
  const [settling, setSettling] = useState(true);

  const apply = useCallback(() => {
    const s = spot.current;
    if (s === null) return;
    const top = targetTop(s, content.current);
    if (top === null) return;
    scrollWindow(top);
    expected.current = window.scrollY;
    near.current = s.kind === 'bottom' || atEnd();
  }, [content]);

  useLayoutEffect(() => {
    if (!opts.ready || done.current) return;
    done.current = true;
    if (!opts.jumping) {
      const root = content.current;
      let s: ScrollSpot =
        opts.unread !== null
          ? { kind: 'item', key: opts.unread, offset: UNREAD_GAP_PX }
          : ((threadId === null ? undefined : memory.get(threadId)) ?? { kind: 'bottom' });
      if (s.kind === 'item' && rowOf(root, s.key) === null) {
        // The first unread row beyond what the thread reveals: as far back as it goes; a remembered row now gone: the end.
        const oldest = opts.unread !== null ? root?.querySelector<HTMLElement>('[data-key]') : null;
        s = oldest?.dataset.key ? { kind: 'item', key: oldest.dataset.key, offset: 0 } : { kind: 'bottom' };
      }
      spot.current = s;
      apply();
    }
    setPositioned(true);
  }, [opts.ready, opts.jumping, opts.unread, threadId, content, apply]);

  useEffect(() => {
    if (!positioned) return;
    if (typeof requestAnimationFrame !== 'function') {
      setSettling(false);
      return;
    }
    let id = requestAnimationFrame(() => {
      id = requestAnimationFrame(() => {
        setSettling(false);
      });
    });
    return () => {
      cancelAnimationFrame(id);
    };
  }, [positioned]);

  // Attached before the first paint: a change in that same frame (the knowledge strip arriving above the thread) is
  // re-anchored before anything is shown.
  useLayoutEffect(() => {
    if (!positioned) return;
    const root = content.current;
    const reapply = (): void => {
      if (spot.current !== null) apply();
    };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reapply);
    if (root !== null) ro?.observe(root);
    ro?.observe(document.body);
    window.addEventListener('resize', reapply);
    if (typeof document.fonts !== 'undefined') void document.fonts.ready.then(reapply);
    const release = (): void => {
      spot.current = null;
    };
    for (const name of USER_INPUT) window.addEventListener(name, release, { capture: true, passive: true });
    // A wheel turned up: the reader goes back to read — stop following at once (even at the very end).
    const intent = watchScrollIntent(window, () => {
      near.current = false;
    });
    let lastY = window.scrollY;
    const raf = (fn: () => void): number => {
      if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(fn);
      fn();
      return 0;
    };
    let frame = 0;
    let check = 0;
    const save = (): void => {
      frame = 0;
      if (threadId === null) return;
      const s = currentSpot(content.current);
      if (s !== null) memory.set(threadId, s);
    };
    const moved = (): boolean =>
      spot.current !== null && expected.current !== null && Math.abs(window.scrollY - expected.current) > 4;
    const onScroll = (): void => {
      // A scroll the anchor did not make (the scrollbar, the find bar): the reader took over. Checked in the next
      // frame: the browser's own scroll anchoring moves the window when rows above change size, and in that frame the
      // scroll events and animation callbacks run before the resize observer re-applies the spot.
      if (check === 0 && moved())
        check = raf(() => {
          check = raf(() => {
            check = 0;
            if (moved()) spot.current = null;
          });
        });
      const y = window.scrollY;
      near.current = followAfterScroll({
        following: near.current,
        top: y,
        lastTop: lastY,
        distanceToEnd: distanceToEnd(),
        userInput: intent.recent(),
      });
      lastY = y;
      if (frame === 0) frame = raf(save);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', reapply);
      for (const name of USER_INPUT) window.removeEventListener(name, release, { capture: true });
      intent.dispose();
      window.removeEventListener('scroll', onScroll);
      if (typeof cancelAnimationFrame === 'function') {
        if (frame !== 0) cancelAnimationFrame(frame);
        if (check !== 0) cancelAnimationFrame(check);
      }
    };
  }, [positioned, content, threadId, apply]);

  return useMemo(
    () => ({
      positioned,
      settling,
      following: () => spot.current?.kind === 'bottom' || near.current,
      toBottom: () => {
        spot.current = { kind: 'bottom' };
        apply();
      },
      release: () => {
        spot.current = null;
      },
    }),
    [positioned, settling, apply],
  );
}
