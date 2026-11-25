// p12-chat-scroll-anchor (docs/design/p12-diyalog.md §18): where a Sohbet conversation opens — the first unread
// answer at the top of the visible thread area under an "Okunmamış mesajlar" divider, else the bottom; a `?m=` jump
// first; the spot kept while rows change height until the reader scrolls; per-conversation memory; older windows
// revealed to reach the first unread. jsdom has no layout, so the window, its scroll position and the rows' boxes are
// a small model here: rows stack from y = 100 (default 100 px each) and the sticky header is 57 px (the knowledge
// strip under it is empty here — these conversations have no project or watches), so the visible thread area starts
// at 57 px.
import { act, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import type { ChatMessage } from '../src/api/chat';
import {
  firstUnreadKey,
  READ_POSITION_TIMEOUT_MS,
  resetScrollMemory,
  UNREAD_GAP_PX,
} from '../src/diyalog/chat/scrollAnchor';
import { THREAD_WINDOW } from '../src/diyalog/Thread';
import { invalidate } from '../src/lib/invalidate';
import { type Handler, type RecordedRequest, renderApp, sessionBody, stubCookies } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const T1 = '00000000-0000-4000-8000-0000000000d1';
const T2 = '00000000-0000-4000-8000-0000000000d2';
const NOW = new Date().toISOString();
const INSET = 57;
const VIEW = 768;

/** Message ids are UUIDs (a `?m=` link takes only those): `10000000-…-<seq>` in the first conversation, `2…` in the second. */
const idOf = (t: string, seq: number): string =>
  `${t === T1 ? '1' : '2'}0000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
/** Message n of a conversation: odd seqs are the reader's questions, even seqs the assistant's answers. */
function messages(t: string, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => {
    const seq = i + 1;
    return {
      id: idOf(t, seq),
      seq,
      role: seq % 2 === 1 ? 'user' : 'assistant',
      content: `${t === T1 ? 'Bir' : 'İki'} ${String(seq)}`,
      meta: null,
      turnId: null,
      createdAt: NOW,
    };
  });
}

function thread(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    unreadCount: 0,
    pinnedAt: null,
    groupId: null,
    tagIds: [],
  };
}

const STATUS = {
  enabled: true,
  available: true,
  code: null,
  message: null,
  worker: { id: 'w1', name: 'mac-1', online: true },
  runtime: 'claude-code',
  model: null,
  limits: { turnsPerUserPer10Min: 30, userDailyTokens: null },
  input: { images: 'supported', pdf: true, mentions: true, reason: null },
};

const ok =
  (body: unknown = {}): Handler =>
  () => ({ status: 200, body });

/** Per conversation: its messages and the caller's read position (what `POST …/read {seq:0}` answers). */
const convo: Record<string, { msgs: Record<string, unknown>[]; lastRead: number }> = {};

function detail(id: string, title: string): Handler {
  return () => ({
    status: 200,
    body: {
      thread: thread(id, title),
      messages: convo[id]?.msgs ?? [],
      drafts: [],
      turn: null,
      watches: [],
      knowledge: null,
      starred: [],
    },
  });
}

function read(id: string): Handler {
  return (req) => {
    const c = convo[id];
    const asked = (req.body as { seq?: number } | undefined)?.seq;
    const last = (c?.msgs.at(-1)?.seq as number | undefined) ?? 0;
    // The master's mark is monotonic: seq 0 answers the current position, a mark moves it forward.
    if (c !== undefined && asked !== 0) c.lastRead = Math.max(c.lastRead, asked ?? last);
    return {
      status: 200,
      body: { threadId: id, lastReadSeq: c?.lastRead ?? 0, lastReadAt: NOW, unreadCount: 0 },
    };
  };
}

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  const empty = ok({ items: [], nextCursor: null });
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/chat/status': ok(STATUS),
    'GET /api/notifications?limit=20': ok({ items: [], unreadCount: 0, nextCursor: null }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/chat/threads': ok({
      items: [thread(T1, 'Birinci sohbet'), thread(T2, 'İkinci sohbet')],
      organize: { groups: [], tags: [], pinned: 0 },
      nextCursor: null,
    }),
    'GET /api/chat/threads?limit=1': ok({ items: [thread(T1, 'Birinci sohbet')], nextCursor: null }),
    [`GET /api/chat/threads/${T1}`]: detail(T1, 'Birinci sohbet'),
    [`GET /api/chat/threads/${T2}`]: detail(T2, 'İkinci sohbet'),
    [`POST /api/chat/threads/${T1}/read`]: read(T1),
    [`POST /api/chat/threads/${T2}/read`]: read(T2),
    [`GET /api/chat/threads/${T1}/assets?kind=starred&limit=30`]: empty,
    [`GET /api/chat/threads/${T2}/assets?kind=starred&limit=30`]: empty,
    [`GET /api/chat/assets?kind=starred&limit=30&thread=${T1}`]: empty,
    [`GET /api/chat/assets?kind=starred&limit=30&thread=${T2}`]: empty,
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/fleet/overview': ok({ workers: [] }),
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------- the layout model

let y = 0;
const heights = new Map<string, number>();
const scrollTo = vi.fn();
const scrollIntoView = vi.fn();
const observers = new Set<{ cb: () => void }>();

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="log"] > li[data-key]')];
}
const heightOf = (li: HTMLElement): number => heights.get(li.dataset.key ?? '') ?? 100;
function absTop(li: HTMLElement): number {
  let top = 100;
  for (const r of rows()) {
    if (r === li) return top;
    top += heightOf(r);
  }
  return top;
}
const total = (): number => 100 + rows().reduce((n, r) => n + heightOf(r), 0) + 300;
const maxY = (): number => Math.max(0, total() - VIEW);
function box(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}
/** The row of message `seq` of `t`: where its top is in the window now. */
function topOf(t: string, seq: number): number {
  const li = rows().find((r) => r.dataset.key === `m:${idOf(t, seq)}`);
  if (li === undefined) throw new Error(`row ${String(seq)} not rendered`);
  return absTop(li) - y;
}
function resize(): void {
  act(() => {
    for (const o of observers) o.cb();
  });
}
/** The reader scrolls (a real scroll: the anchor did not make it). */
async function readerScrolls(to: number): Promise<void> {
  y = to;
  window.dispatchEvent(new Event('wheel'));
  window.dispatchEvent(new Event('scroll'));
  await new Promise((r) => setTimeout(r, 50));
}

const scrollYDescriptor = Object.getOwnPropertyDescriptor(window, 'scrollY');

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
  window.localStorage.clear();
  resetScrollMemory();
  y = 0;
  heights.clear();
  observers.clear();
  scrollTo.mockReset();
  scrollTo.mockImplementation((o: { top: number }) => {
    y = Math.min(Math.max(0, o.top), maxY());
    setTimeout(() => window.dispatchEvent(new Event('scroll')), 0);
  });
  scrollIntoView.mockReset();
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y });
  vi.stubGlobal('scrollTo', scrollTo);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      readonly entry: { cb: () => void };
      constructor(cb: () => void) {
        this.entry = { cb };
      }
      observe(): void {
        observers.add(this.entry);
      }
      unobserve(): void {
        // not needed
      }
      disconnect(): void {
        observers.delete(this.entry);
      }
    },
  );
  Element.prototype.scrollIntoView = scrollIntoView;
  // The tab is visible and focused: the read mark runs (p9-chat-unread).
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockImplementation(total);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this instanceof HTMLElement && this.matches('[role="log"] > li[data-key]'))
      return box(absTop(this) - y, heightOf(this));
    if (this instanceof HTMLElement && this.dataset.testid === 'dy-sohbet-head') return box(0, 57);
    if (this instanceof HTMLElement && this.hasAttribute('data-dy-sticky'))
      return box(57, this.childElementCount > 0 ? 40 : 0);
    return box(0, 0);
  });
  const css = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
    const cs = css(el, pseudo);
    if (!(el instanceof HTMLElement) || !el.hasAttribute('data-dy-sticky')) return cs;
    const top = el.dataset.testid === 'dy-sohbet-head' ? '0px' : '57px';
    return new Proxy(cs, {
      get: (t, k) => {
        if (k === 'position') return 'sticky';
        if (k === 'top') return top;
        const v: unknown = Reflect.get(t, k);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (scrollYDescriptor !== undefined) Object.defineProperty(window, 'scrollY', scrollYDescriptor);
});

function calls(requests: RecordedRequest[], method: string, suffix: string): RecordedRequest[] {
  return requests.filter((r) => r.method === method && r.url.endsWith(suffix));
}

async function opened(t: string): Promise<HTMLElement> {
  const log = await screen.findByRole('log', { name: 'Sohbet' });
  await within(log)
    .findByText(`${t === T1 ? 'Bir' : 'İki'} 1`, {}, { timeout: 5_000 })
    .catch(() => undefined);
  await waitFor(() => {
    expect(rows().length).toBeGreaterThan(0);
  });
  return log;
}

describe('firstUnreadKey', () => {
  const m = (seq: number, role: string): ChatMessage => ({
    id: `id-${String(seq)}`,
    seq,
    role: role as ChatMessage['role'],
    content: '',
    meta: null,
    turnId: null,
    createdAt: NOW,
  });
  it('is the first answer or error after the read position; the reader’s own messages never are', () => {
    const list = [
      m(1, 'user'),
      m(2, 'assistant'),
      m(3, 'user'),
      m(4, 'tool'),
      m(5, 'error'),
      m(6, 'assistant'),
    ];
    expect(firstUnreadKey(list, 2)).toBe('m:id-5');
    expect(firstUnreadKey(list, 0)).toBe('m:id-2');
    expect(firstUnreadKey(list, 6)).toBeNull();
    expect(firstUnreadKey([m(7, 'user')], 6)).toBeNull();
    expect(firstUnreadKey(list, null)).toBeNull();
  });
});

describe('Sohbet scroll anchor (p12-chat-scroll-anchor)', { timeout: 30_000 }, () => {
  it('opens at the very bottom when nothing is unread, without a divider', async () => {
    convo[T1] = { msgs: messages(T1, 30), lastRead: 30 };
    renderApp({ path: `/chat/${T1}`, initialState: signedIn, routes: routes() });
    await opened(T1);
    await waitFor(() => {
      expect(y).toBe(maxY());
    });
    expect(maxY()).toBeGreaterThan(0);
    expect(screen.queryByTestId('unread-divider')).toBeNull();
  });

  it('opens with the first unread answer at the top under the header, the divider above it; read after', async () => {
    convo[T1] = { msgs: messages(T1, 30), lastRead: 20 };
    const { requests } = renderApp({ path: `/chat/${T1}`, initialState: signedIn, routes: routes() });
    await opened(T1);
    // The first unread is the answer #22 (#21 is the reader's own question).
    await waitFor(() => {
      expect(topOf(T1, 22)).toBe(INSET + UNREAD_GAP_PX);
    });
    const divider = screen.getByRole('separator', { name: 'Okunmamış mesajlar' });
    expect(divider.closest('li')?.dataset.key).toBe(`m:${idOf(T1, 22)}`);
    // The position was read (seq 0, never moving it) before the read mark of the newest message.
    const reads = calls(requests, 'POST', `/chat/threads/${T1}/read`);
    expect(reads[0]?.body).toEqual({ seq: 0 });
    await waitFor(() => {
      expect(calls(requests, 'POST', `/chat/threads/${T1}/read`).at(-1)?.body).toEqual({ seq: 30 });
    });
    // The divider stays while the reader is in the conversation (a poll / reload does not drop it).
    expect(screen.getByTestId('unread-divider')).toBeTruthy();
  });

  it('keeps the anchor while rows above it grow (images, code, fonts) until the reader scrolls', async () => {
    convo[T1] = { msgs: messages(T1, 30), lastRead: 20 };
    renderApp({ path: `/chat/${T1}`, initialState: signedIn, routes: routes() });
    await opened(T1);
    await waitFor(() => {
      expect(topOf(T1, 22)).toBe(INSET + UNREAD_GAP_PX);
    });
    // An image in answer #10 and a code block in #20 load: their rows grow; the first unread stays put.
    heights.set(`m:${idOf(T1, 10)}`, 420);
    heights.set(`m:${idOf(T1, 20)}`, 260);
    resize();
    expect(topOf(T1, 22)).toBe(INSET + UNREAD_GAP_PX);
    // Rows under it grow too (an answer's badges): nothing moves.
    heights.set(`m:${idOf(T1, 26)}`, 300);
    resize();
    expect(topOf(T1, 22)).toBe(INSET + UNREAD_GAP_PX);
    // The reader scrolls: the thread no longer holds the spot.
    await readerScrolls(500);
    heights.set(`m:${idOf(T1, 4)}`, 700);
    resize();
    expect(y).toBe(500);
  });

  it('a ?m= jump wins over the unread anchor and the bottom', async () => {
    convo[T1] = { msgs: messages(T1, 30), lastRead: 20 };
    renderApp({ path: `/chat/${T1}?m=${idOf(T1, 6)}`, initialState: signedIn, routes: routes() });
    await opened(T1);
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
    });
    const target = scrollIntoView.mock.contexts.at(-1) as HTMLElement;
    expect(target.dataset.messageId).toBe(idOf(T1, 6));
    // The thread did not scroll itself to the first unread or the end.
    expect(scrollTo).not.toHaveBeenCalled();
    expect(y).toBe(0);
    resize();
    expect(y).toBe(0);
  });

  it('switching conversations: each opens on its own (unread anchor, bottom) and returning restores the place', async () => {
    const user = userEvent.setup();
    convo[T1] = { msgs: messages(T1, 30), lastRead: 20 };
    convo[T2] = { msgs: messages(T2, 24), lastRead: 24 };
    renderApp({ path: `/chat/${T1}`, initialState: signedIn, routes: routes() });
    await opened(T1);
    await waitFor(() => {
      expect(topOf(T1, 22)).toBe(INSET + UNREAD_GAP_PX);
    });
    const nav = screen.getByRole('navigation', { name: 'Sohbet listesi' });
    // To the second conversation: nothing unread there → its bottom.
    await user.click(await within(nav).findByText('İkinci sohbet'));
    await screen.findByText('İki 1');
    await waitFor(() => {
      expect(y).toBe(maxY());
    });
    expect(screen.queryByTestId('unread-divider')).toBeNull();
    // The reader scrolls up to answer #8 of the second conversation (its top 30 px under the header).
    const at8 = (): number => topOf(T2, 8) + y;
    await readerScrolls(at8() - INSET - 30);
    expect(topOf(T2, 8)).toBe(INSET + 30);
    // Back to the first: everything there was read on the first visit → where the reader was (the first unread spot).
    await user.click(await within(nav).findByText('Birinci sohbet'));
    await screen.findByText('Bir 1');
    await waitFor(() => {
      expect(topOf(T1, 22)).toBe(INSET + UNREAD_GAP_PX);
    });
    expect(screen.queryByTestId('unread-divider')).toBeNull();
    // And to the second again: the remembered place, not the bottom.
    await user.click(await within(nav).findByText('İkinci sohbet'));
    await screen.findByText('İki 1');
    await waitFor(() => {
      expect(topOf(T2, 8)).toBe(INSET + 30);
    });
    // New answers arrived in the second while away: the first unread wins over the remembered place.
    await user.click(await within(nav).findByText('Birinci sohbet'));
    await screen.findByText('Bir 1');
    convo[T2] = { msgs: messages(T2, 40), lastRead: 24 };
    await user.click(await within(nav).findByText('İkinci sohbet'));
    await screen.findByText('İki 39');
    await waitFor(() => {
      expect(topOf(T2, 26)).toBe(INSET + UNREAD_GAP_PX);
    });
    expect(screen.getByTestId('unread-divider').closest('li')?.dataset.key).toBe(`m:${idOf(T2, 26)}`);
  });

  it('reveals older windows ("Daha eski …") until the first unread is rendered', async () => {
    // 400 messages: the thread shows the newest THREAD_WINDOW rows; the first unread (#102) is far older.
    convo[T1] = { msgs: messages(T1, 400), lastRead: 100 };
    renderApp({ path: `/chat/${T1}`, initialState: signedIn, routes: routes() });
    await opened(T1);
    await waitFor(() => {
      expect(topOf(T1, 102)).toBe(INSET + UNREAD_GAP_PX);
    });
    expect(rows().length).toBeGreaterThan(THREAD_WINDOW);
    expect(screen.getByTestId('unread-divider').closest('li')?.dataset.key).toBe(`m:${idOf(T1, 102)}`);
    // The rest stays behind the button.
    expect(screen.getByRole('button', { name: /Daha eski \d+ öğeyi göster/ })).toBeTruthy();
  });

  it('follows new answers at the bottom; a reader further up gets the "Yeni içerik ↓" pill instead', async () => {
    const user = userEvent.setup();
    convo[T1] = { msgs: messages(T1, 30), lastRead: 30 };
    renderApp({ path: `/chat/${T1}`, initialState: signedIn, routes: routes() });
    await opened(T1);
    await waitFor(() => {
      expect(y).toBe(maxY());
    });
    // A new answer at the bottom: followed.
    convo[T1] = { msgs: messages(T1, 32), lastRead: 30 };
    act(() => {
      invalidate('chat');
    });
    await screen.findByText('Bir 32');
    await waitFor(() => {
      expect(y).toBe(maxY());
    });
    // A poll with nothing new neither moves the reader nor raises the pill.
    await readerScrolls(400);
    act(() => {
      invalidate('chat');
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(y).toBe(400);
    expect(screen.queryByRole('button', { name: 'Yeni içerik ↓' })).toBeNull();
    // New content while the reader is up: the pill, no jump; the pill takes the reader to the end.
    convo[T1] = { msgs: messages(T1, 34), lastRead: 32 };
    act(() => {
      invalidate('chat');
    });
    const pill = await screen.findByRole('button', { name: 'Yeni içerik ↓' });
    expect(y).toBe(400);
    await user.click(pill);
    expect(y).toBe(maxY());
  });

  it('p15-chat-cards-scroll: while an answer streams, a reader who scrolls up (even a little) is not pulled down; back at the end it follows again', async () => {
    const streams: StreamSource[] = [];
    class StreamSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readyState = 1;
      onerror: (() => void) | null = null;
      readonly listeners = new Map<string, ((m: MessageEvent<string>) => void)[]>();
      constructor(readonly url: string) {
        streams.push(this);
      }
      addEventListener(name: string, fn: (m: MessageEvent<string>) => void): void {
        this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
      }
      close(): void {
        this.readyState = 2;
      }
      emit(name: string, data: unknown): void {
        act(() => {
          for (const fn of this.listeners.get(name) ?? [])
            fn(new MessageEvent('message', { data: JSON.stringify(data) }));
        });
      }
    }
    vi.stubGlobal('EventSource', StreamSource);
    convo[T1] = { msgs: messages(T1, 30), lastRead: 30 };
    renderApp({ path: `/chat/${T1}`, initialState: signedIn, routes: routes() });
    await opened(T1);
    await waitFor(() => {
      expect(y).toBe(maxY());
    });
    const es = streams.at(-1);
    if (es === undefined) throw new Error('no stream');
    // The answer starts streaming at the end: followed.
    es.emit('turn', { id: 'k1' });
    es.emit('delta', { text: 'Birinci parça. ', turnId: 'k1' });
    await waitFor(() => {
      expect(y).toBe(maxY());
    });
    // The reader scrolls up only 30 px to read (well inside the old 240 px "near the bottom" zone).
    const atReading = maxY() - 30;
    await readerScrolls(atReading);
    heights.set('live', 400);
    es.emit('delta', { text: 'İkinci parça, daha uzun. ', turnId: 'k1' });
    resize();
    await new Promise((r) => setTimeout(r, 50));
    expect(y).toBe(atReading);
    const pill = await screen.findByRole('button', { name: 'Yeni içerik ↓' });
    // A wheel turned up at the very end also stops following at once.
    heights.set('live', 500);
    es.emit('delta', { text: 'Üçüncü. ', turnId: 'k1' });
    expect(y).toBe(atReading);
    // Back at the end by scrolling: the pill goes away and the stream is followed again.
    await readerScrolls(maxY());
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Yeni içerik ↓' })).toBeNull();
    });
    expect(pill.isConnected).toBe(false);
    heights.set('live', 800);
    es.emit('delta', { text: 'Dördüncü. ', turnId: 'k1' });
    await waitFor(() => {
      expect(y).toBe(maxY());
    });
    // A wheel turned up (deltaY < 0) right at the end stops following even before anything scrolls.
    act(() => {
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }));
    });
    const held = y;
    heights.set('live', 1000);
    es.emit('delta', { text: 'Beşinci. ', turnId: 'k1' });
    await new Promise((r) => setTimeout(r, 50));
    expect(y).toBe(held);
    expect(await screen.findByRole('button', { name: 'Yeni içerik ↓' })).toBeTruthy();
  });

  it('the phone keyboard opening (focus in the composer, viewport resize) does not move the thread', async () => {
    convo[T1] = { msgs: messages(T1, 30), lastRead: 20 };
    renderApp({ path: `/chat/${T1}`, initialState: signedIn, routes: routes() });
    await opened(T1);
    await waitFor(() => {
      expect(topOf(T1, 22)).toBe(INSET + UNREAD_GAP_PX);
    });
    const before = y;
    const box = await screen.findByRole('textbox', { name: 'Mesaj' });
    box.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    box.focus();
    // The keyboard takes room: the viewport resizes, rows reflow.
    heights.set(`m:${idOf(T1, 2)}`, 180);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    resize();
    expect(y).toBe(before);
  });

  it('opens at the bottom when the read position cannot be read in time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      convo[T1] = { msgs: messages(T1, 30), lastRead: 20 };
      renderApp({
        path: `/chat/${T1}`,
        initialState: signedIn,
        routes: routes({
          [`POST /api/chat/threads/${T1}/read`]: () => ({
            status: 500,
            body: { error: 'internal', message: 'boom' },
          }),
        }),
      });
      await vi.advanceTimersByTimeAsync(READ_POSITION_TIMEOUT_MS);
      await opened(T1);
      await waitFor(() => {
        expect(y).toBe(maxY());
      });
      expect(screen.queryByTestId('unread-divider')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('p17-panel-motion: arrivals animate (never the opening rows) and the follow rule is unchanged — at the end it follows, further up it does not move', async () => {
    // The browser can run Web Animations here (jsdom cannot): the motion code is live during this test.
    const animate = vi.fn(() => ({ addEventListener: vi.fn(), cancel: vi.fn() }));
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    try {
      convo[T1] = { msgs: messages(T1, 30), lastRead: 30 };
      renderApp({ path: `/chat/${T1}`, initialState: signedIn, routes: routes() });
      await opened(T1);
      await waitFor(() => {
        expect(y).toBe(maxY());
      });
      // The rows the conversation opened with stand still.
      expect(document.querySelectorAll('[role="log"] > li.dy-enter')).toHaveLength(0);
      // A question and its answer arrive together: they rise in, the second a stagger step later; the question from the
      // reader's side. The reader at the end is followed.
      convo[T1] = { msgs: messages(T1, 32), lastRead: 30 };
      act(() => {
        invalidate('chat');
      });
      await screen.findByText('Bir 32');
      const q = rows().find((r) => r.dataset.key === `m:${idOf(T1, 31)}`);
      const a = rows().find((r) => r.dataset.key === `m:${idOf(T1, 32)}`);
      expect(q?.classList.contains('dy-enter')).toBe(true);
      expect(q?.dataset.enter).toBe('me');
      expect(a?.classList.contains('dy-enter')).toBe(true);
      expect(a?.style.getPropertyValue('--dy-i')).toBe('1');
      await waitFor(() => {
        expect(y).toBe(maxY());
      });
      // Further up: new rows still arrive animated, but the reader is not moved — the pill instead.
      await readerScrolls(400);
      convo[T1] = { msgs: messages(T1, 34), lastRead: 32 };
      act(() => {
        invalidate('chat');
      });
      await screen.findByRole('button', { name: 'Yeni içerik ↓' });
      expect(
        rows()
          .find((r) => r.dataset.key === `m:${idOf(T1, 34)}`)
          ?.classList.contains('dy-enter'),
      ).toBe(true);
      resize();
      expect(y).toBe(400);
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    }
  });
});
