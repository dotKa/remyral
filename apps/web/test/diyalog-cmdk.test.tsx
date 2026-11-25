// p12-diyalog-cmdk (docs/design/p12-diyalog.md §17): the Sohbet header over the details panel, the open / close motion
// primitive (and reduced motion), collision-aware menus, the conversation list staying mounted across conversations,
// and the ⌘K / Ctrl+K command palette (Turkish-aware fuzzy matching, keyboard, AI search through the existing
// permission-checked endpoint, "Asistana sor", what the caller may see).
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { place } from '../src/diyalog/floating';
import { motionMs, presenceProps, usePresence } from '../src/diyalog/motion';
import { fold, rank, score } from '../src/diyalog/palette/match';
import { readRecent, rememberRecent } from '../src/diyalog/palette/recent';
import { type Handler, type RecordedRequest, renderApp, sessionBody, stubCookies } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const viewer: AuthState = {
  kind: 'signedIn',
  user: { id: 'u2', username: 'izleyici', role: 'viewer' },
  session: null,
  remainingRecoveryCodes: null,
};

const T1 = '00000000-0000-4000-8000-0000000000d1';
const T2 = '00000000-0000-4000-8000-0000000000d2';
const T3 = '00000000-0000-4000-8000-0000000000d3';
const T9 = '00000000-0000-4000-8000-0000000000d9';
const M1 = '00000000-0000-4000-8000-0000000000a1';
const J1 = '7f3a9c2e-0000-4000-8000-0000000000b1';
const NOW = new Date().toISOString();

function thread(id: string, title: string, over: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...over,
  };
}

const ALL = [
  thread(T3, 'Plain chat', { unreadCount: 3 }),
  thread(T1, 'Pinned talk', { pinnedAt: NOW }),
  thread(T2, 'Şifre sıfırlama akışı', { unreadCount: 2 }),
];
const ORGANIZE = { groups: [], tags: [], pinned: 0 };

const AVAILABLE = {
  enabled: true,
  available: true,
  code: null,
  message: null,
  worker: { id: 'w1', name: 'mac-1', online: true },
  runtime: 'claude-code',
  model: 'claude-sonnet-4-5',
  limits: { turnsPerUserPer10Min: 30, userDailyTokens: 2000000 },
};

const msg = (id: string, seq: number, role: string, content: string) => ({
  id,
  seq,
  role,
  content,
  meta: null,
  turnId: null,
  createdAt: NOW,
});

const ok =
  (body: unknown = {}): Handler =>
  () => ({ status: 200, body });
const empty = { status: 200, body: { items: [], nextCursor: null } };

function detailOf(id: string, title: string): Handler {
  return () => ({
    status: 200,
    body: {
      thread: thread(id, title),
      messages: [msg(M1, 1, 'assistant', `Hello from ${title}`)],
      drafts: [],
      turn: null,
      watches: [],
      starred: [],
    },
  });
}

function job(id: string, title: string, state: string): Record<string, unknown> {
  return {
    id,
    project: 'acme',
    projectKind: 'repository',
    state,
    runtime: 'codex',
    title,
    attempts: 1,
    workerId: null,
    createdBy: { type: 'user', id: 'u1' },
    createdAt: NOW,
    stateChangedAt: NOW,
  };
}

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/chat/status': ok(AVAILABLE),
    'GET /api/notifications?limit=20': ok({ items: [], unreadCount: 0, nextCursor: null }),
    'GET /api/chat/unread': ok({ total: 5, threads: 2 }),
    'GET /api/chat/threads': ok({ items: ALL, organize: ORGANIZE, nextCursor: null }),
    'GET /api/chat/threads?limit=1': ok({ items: [ALL[0]], nextCursor: null }),
    [`GET /api/chat/threads/${T3}`]: detailOf(T3, 'Plain chat'),
    [`GET /api/chat/threads/${T2}`]: detailOf(T2, 'Şifre sıfırlama akışı'),
    [`POST /api/chat/threads/${T3}/read`]: ok({
      threadId: T3,
      lastReadSeq: 1,
      lastReadAt: NOW,
      unreadCount: 0,
    }),
    [`POST /api/chat/threads/${T2}/read`]: ok({
      threadId: T2,
      lastReadSeq: 1,
      lastReadAt: NOW,
      unreadCount: 0,
    }),
    [`GET /api/chat/threads/${T3}/assets?kind=starred&limit=30`]: () => empty,
    [`GET /api/chat/assets?kind=starred&limit=30&thread=${T3}`]: () => empty,
    'GET /api/ops-thread?limit=50': () => ({
      status: 404,
      body: { error: 'not_found', message: 'Not found.' },
    }),
    'GET /api/approvals?status=pending': ok({ items: [] }),
    'GET /api/jobs?limit=50': ok({
      items: [job(J1, 'Ödeme API testlerini düzelt', 'RUNNING')],
      nextCursor: null,
    }),
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/projects': ok({ items: [] }),
    'GET /api/automations': ok({ items: [] }),
    'GET /api/templates?state=active': ok({ items: [] }),
    'GET /api/fleet/overview': ok({ workers: [] }),
    ...extra,
  };
}

/** Exact routes plus prefix routes (`GET /api/chat/mentions?q=` answers every query). */
function withPrefixes(
  exact: Record<string, Handler>,
  prefixes: Record<string, Handler>,
): Record<string, Handler> {
  return new Proxy(exact, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key in target) return target[key];
      const p = Object.keys(prefixes).find((k) => key.startsWith(k));
      return p === undefined ? undefined : prefixes[p];
    },
  });
}

const mentionsNone: Record<string, Handler> = { 'GET /api/chat/mentions?q=': ok({ items: [] }) };

function calls(requests: RecordedRequest[], method: string, part: string): RecordedRequest[] {
  return requests.filter((r) => r.method === method && r.url.includes(part));
}

function mockMatchMedia(matches: (q: string) => boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (q: string) =>
      ({
        matches: matches(q),
        media: q,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------------------------------------ matching

describe('Turkish-aware fuzzy matching (palette/match.ts)', () => {
  it('folds Turkish letters and the dotted / dotless i both ways', () => {
    expect(fold('İşler')).toBe('isler');
    expect(fold('IŞIK')).toBe('isik');
    expect(fold('Çıktılar ğüö')).toBe('ciktilar guo');
    expect(fold('INBOX')).toBe('inbox');
  });

  it('matches without Turkish characters, ranks word starts and short labels first, keywords count', () => {
    expect(score('isler', 'İşler')).not.toBeNull();
    expect(score('sifre', 'Şifre sıfırlama akışı')).not.toBeNull();
    expect(score('cikti', 'Çıktılar')).not.toBeNull();
    expect(score('xyz', 'İşler')).toBeNull();
    // subsequence ("kllnm" → Kullanım), but scattered letters over a long text are not a match
    expect(score('kllnm', 'Kullanım')).not.toBeNull();
    expect(score('aaaa', 'a b c d e f g h i j k l m n o p q r s t u v w x y z a b c a d a')).toBeNull();
    const ranked = rank('isler', ['Kuyruk · İşler', 'İşler', 'Yeni işler formu'], (s) => s);
    expect(ranked[0]).toBe('İşler');
    expect(
      rank(
        'queue',
        [
          { l: 'Kuyruk', k: 'queue jobs' },
          { l: 'İşler', k: '' },
        ],
        (x) => x.l,
        (x) => x.k,
      ),
    ).toEqual([{ l: 'Kuyruk', k: 'queue jobs' }]);
  });

  it('remembers recent places per user (navigations only, safe paths, newest first, at most 8)', () => {
    for (let i = 0; i < 10; i += 1)
      rememberRecent('u1', {
        id: `page:/p${String(i)}`,
        section: 'pages',
        label: `P${String(i)}`,
        icon: 'home',
        to: `/p${String(i)}`,
      });
    rememberRecent('u1', {
      id: 'evil',
      section: 'pages',
      label: 'x',
      icon: 'home',
      to: 'https://evil.example',
    });
    rememberRecent('u1', { id: 'act', section: 'actions', label: 'Çıkış', icon: 'key', action: 'logout' });
    const list = readRecent('u1');
    expect(list.map((r) => r.label)).toEqual(['P9', 'P8', 'P7', 'P6', 'P5', 'P4', 'P3', 'P2']);
    expect(readRecent('u2')).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ placement

describe('collision-aware placement (floating.ts)', () => {
  const view = { width: 1024, height: 768 };
  it('opens below with the right edges aligned when it fits', () => {
    const p = place({ top: 100, bottom: 132, left: 900, right: 932 }, { width: 224, height: 200 }, view);
    expect(p.side).toBe('bottom');
    expect(p.top).toBe(136);
    expect(p.left).toBe(932 - 224);
  });
  it('flips up near the bottom edge', () => {
    const p = place({ top: 700, bottom: 732, left: 500, right: 532 }, { width: 224, height: 300 }, view);
    expect(p.side).toBe('top');
    expect(p.top).toBe(700 - 4 - 300);
  });
  it('shifts inside the window with an 8 px margin (left and right)', () => {
    expect(place({ top: 10, bottom: 40, left: 0, right: 30 }, { width: 224, height: 100 }, view).left).toBe(
      8,
    );
    expect(
      place({ top: 10, bottom: 40, left: 990, right: 1020 }, { width: 224, height: 100 }, view, {
        align: 'start',
      }).left,
    ).toBe(1024 - 8 - 224);
  });
  it('too tall for either side: the roomier side with a max height (the content scrolls)', () => {
    const p = place({ top: 300, bottom: 330, left: 10, right: 40 }, { width: 200, height: 2000 }, view);
    expect(p.side).toBe('bottom');
    expect(p.maxHeight).toBe(768 - 330 - 4 - 8);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(768 - 8);
  });
});

// ------------------------------------------------------------------------------------------------ motion

function Box(props: { readonly initial?: boolean }): ReactNode {
  const [open, setOpen] = useState(props.initial ?? true);
  const p = usePresence<HTMLDivElement>(open);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        toggle
      </button>
      {p.mounted ? (
        <div ref={p.ref} data-testid="box" {...presenceProps(p)}>
          box
        </div>
      ) : null}
    </>
  );
}

function stubTransition(duration: string): void {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
    const cs = real(el, pseudo);
    if ((el as HTMLElement).dataset.testid !== 'box') return cs;
    return new Proxy(cs, {
      get(t, k) {
        if (k === 'transitionDuration') return duration;
        if (k === 'transitionDelay') return '0s';
        const v: unknown = Reflect.get(t, k, t);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  });
}

describe('presence motion (motion.ts)', () => {
  it('reads the longest transition / animation of an element', () => {
    const el = document.createElement('div');
    el.style.transitionDuration = '0.2s, 120ms';
    el.style.transitionDelay = '0s, 100ms';
    expect(motionMs(el)).toBe(220);
    expect(motionMs(document.createElement('div'))).toBe(0);
  });

  it('without CSS motion an element leaves in the same commit', async () => {
    const user = userEvent.setup();
    render(<Box />);
    expect(screen.getByTestId('box').getAttribute('data-state')).toBe('open');
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.queryByTestId('box')).toBeNull();
  });

  it('with a transition it stays (closed, inert) until transitionend; reopening interrupts the exit', async () => {
    stubTransition('0.2s');
    const user = userEvent.setup();
    render(<Box />);
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    const box = screen.getByTestId('box');
    expect(box.getAttribute('data-state')).toBe('closed');
    expect(box.hasAttribute('inert')).toBe(true);
    // Reopen mid-exit: the same element turns back.
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('box')).toBe(box);
    expect(box.getAttribute('data-state')).toBe('open');
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    act(() => {
      fireEvent.transitionEnd(box);
    });
    expect(screen.queryByTestId('box')).toBeNull();
  });

  it('reduced motion: no exit animation even when CSS would transition', async () => {
    stubTransition('0.2s');
    mockMatchMedia((q) => q.includes('prefers-reduced-motion'));
    const user = userEvent.setup();
    render(<Box />);
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.queryByTestId('box')).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ Sohbet layout

describe('Sohbet layout and the conversation list', () => {
  it('the header spans the content area; the details panel opens under it, beside the thread', async () => {
    const user = userEvent.setup();
    renderApp({ path: `/chat/${T3}`, initialState: owner, routes: withPrefixes(routes(), mentionsNone) });
    const head = await screen.findByTestId('dy-sohbet-head');
    await user.click(screen.getByTestId('sidebar-toggle'));
    const details = await screen.findByTestId('dy-details');
    const main = screen.getByTestId('dy-sohbet-main');
    const body = screen.getByTestId('dy-sohbet-body');
    // header → main; body (thread + details) → main, after the header; the header is not beside the panel
    expect(head.parentElement).toBe(main);
    expect(body.parentElement).toBe(main);
    expect(details.parentElement).toBe(body);
    expect(head.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(body).getByTestId('dy-sohbet-thread')).toBeTruthy();
    expect(head.contains(details)).toBe(false);
    // Closing returns focus to the toggle.
    await user.click(within(details).getByRole('button', { name: 'Ayrıntıları kapat' }));
    expect(screen.queryByTestId('dy-details')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('sidebar-toggle'));
  });

  it('switching conversations keeps the list mounted (no reload, scroll kept) and clears the opened row at once', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/chat/${T3}`,
      initialState: owner,
      routes: withPrefixes(routes(), mentionsNone),
    });
    const nav = await screen.findByRole('navigation', { name: 'Sohbet listesi' });
    await within(nav).findByText('Şifre sıfırlama akışı');
    const scroller = screen.getByTestId('thread-scroll');
    scroller.scrollTop = 120;
    const listCalls =
      calls(requests, 'GET', '/api/chat/threads?').length +
      calls(requests, 'GET', '/api/chat/threads').filter((r) => r.url.endsWith('/api/chat/threads')).length;
    const row = within(nav).getByText('Şifre sıfırlama akışı').closest('a');
    if (row === null) throw new Error('no row link');
    expect(within(row).queryByText('2')).toBeTruthy();
    await user.click(row);
    await screen.findByText('Hello from Şifre sıfırlama akışı');
    // Same list element, same scroll position, no loading state, no new list request.
    expect(screen.getByRole('navigation', { name: 'Sohbet listesi' })).toBe(nav);
    expect(screen.getByTestId('thread-scroll')).toBe(scroller);
    expect(scroller.scrollTop).toBe(120);
    expect(within(nav).queryByText(/yükleniyor/i)).toBeNull();
    expect(
      calls(requests, 'GET', '/api/chat/threads?').length +
        calls(requests, 'GET', '/api/chat/threads').filter((r) => r.url.endsWith('/api/chat/threads')).length,
    ).toBe(listCalls);
    // The opened row is current at once; its unread count is gone; the previous one stays cleared too.
    const now = within(nav).getByText('Şifre sıfırlama akışı').closest('a');
    expect(now?.getAttribute('aria-current')).toBe('page');
    expect(within(now as HTMLElement).queryByText('2')).toBeNull();
    const plain = within(nav).getByText('Plain chat').closest('a');
    expect(within(plain as HTMLElement).queryByText('3')).toBeNull();
  });

  it('a row menu near the bottom-right corner flips up and stays inside the window', async () => {
    const user = userEvent.setup();
    renderApp({ path: `/chat/${T3}`, initialState: owner, routes: withPrefixes(routes(), mentionsNone) });
    const nav = await screen.findByRole('navigation', { name: 'Sohbet listesi' });
    const button = await within(nav).findByRole('button', { name: 'Şifre sıfırlama akışı için eylemler' });
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(768);
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      top: 730,
      bottom: 762,
      left: 1000,
      right: 1020,
      width: 20,
      height: 32,
      x: 1000,
      y: 730,
      toJSON: () => ({}),
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(224);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(260);
    await user.click(button);
    const menu = screen.getByRole('menu', { name: 'Şifre sıfırlama akışı için eylemler' });
    const top = Number.parseFloat(menu.style.top);
    const left = Number.parseFloat(menu.style.left);
    expect(menu.getAttribute('data-side')).toBe('top');
    expect(top + 260).toBeLessThanOrEqual(730);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(left + 224).toBeLessThanOrEqual(1024 - 8);
    expect(left).toBeGreaterThanOrEqual(8);
    // Rendered in the Diyalog scope root (not inside the scrolling list), first item focused.
    expect(nav.contains(menu)).toBe(false);
    expect(menu.closest('[data-ui="diyalog"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
  });

  it('on phones a row menu is a bottom sheet over a scrim (tap the scrim to close)', async () => {
    mockMatchMedia((q) => q.includes('max-width: 639.98px'));
    const user = userEvent.setup();
    renderApp({ path: `/chat/${T3}`, initialState: owner, routes: withPrefixes(routes(), mentionsNone) });
    await user.click(await screen.findByTestId('dy-conversations-toggle'));
    const nav = await screen.findByRole('navigation', { name: 'Sohbet listesi' });
    await user.click(await within(nav).findByRole('button', { name: 'Plain chat için eylemler' }));
    const menu = screen.getByRole('menu', { name: 'Plain chat için eylemler' });
    expect(menu.getAttribute('data-sheet')).toBe('true');
    expect(menu.style.top).toBe('');
    await user.click(screen.getByTestId('dy-popover-scrim'));
    expect(screen.queryByRole('menu', { name: 'Plain chat için eylemler' })).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ palette

async function openPalette(user: ReturnType<typeof userEvent.setup>, combo = '{Control>}k{/Control}') {
  await user.keyboard(combo);
  return screen.findByTestId('dy-palette-input');
}

function options(): HTMLElement[] {
  return within(screen.getByRole('listbox')).queryAllByRole('option');
}

describe('command palette', () => {
  it('opens with Ctrl+K and ⌘K (toggles), from the rail button, and is an accessible combobox', async () => {
    const user = userEvent.setup();
    renderApp({ path: `/chat/${T3}`, initialState: owner, routes: withPrefixes(routes(), mentionsNone) });
    await screen.findByTestId('dy-sohbet-head');
    const input = await openPalette(user);
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
    expect(screen.getByTestId('dy-palette').hasAttribute('open')).toBe(true);
    // Empty query: actions and pages are offered (and the chats once the index arrived).
    expect(within(screen.getByRole('listbox')).getByRole('group', { name: 'Eylemler' })).toBeTruthy();
    await user.keyboard('{Meta>}k{/Meta}');
    expect(screen.getByTestId('dy-palette').hasAttribute('open')).toBe(false);
    await user.click(screen.getByTestId('dy-palette-button'));
    expect(await screen.findByTestId('dy-palette-input')).toBeTruthy();
  });

  it('finds pages, tabs, settings, chats and jobs without Turkish letters; arrows + Enter navigate', async () => {
    const user = userEvent.setup();
    renderApp({ path: `/chat/${T3}`, initialState: owner, routes: withPrefixes(routes(), mentionsNone) });
    await screen.findByTestId('dy-sohbet-head');
    const input = await openPalette(user);
    await user.type(input, 'kuyruk');
    expect(options()[0]?.textContent).toContain('Kuyruk');
    await user.clear(input);
    await user.type(input, 'kullanicilar');
    expect(options().some((o) => o.textContent.includes('Kullanıcılar'))).toBe(true);
    await user.clear(input);
    await user.type(input, 'odeme api');
    await waitFor(() => {
      expect(options().some((o) => o.textContent.includes('Ödeme API testlerini düzelt'))).toBe(true);
    });
    await user.clear(input);
    await user.type(input, 'sifre sifirlama');
    await waitFor(() => {
      expect(
        within(screen.getByRole('group', { name: 'Sohbetler' })).getByText('Şifre sıfırlama akışı'),
      ).toBeTruthy();
    });
    // The count is announced.
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(
      /sonuç/,
    );
    // Keyboard: first option active; ArrowDown moves; the chat is first in its group — Tab jumps to the next group.
    const first = options()[0];
    expect(first?.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(first?.id);
    const chatsGroup = screen.getByRole('group', { name: 'Sohbetler' });
    // Tab until the chats group is active, then Enter opens the conversation.
    for (let i = 0; i < 5 && within(chatsGroup).queryByRole('option', { selected: true }) === null; i += 1)
      await user.keyboard('{Tab}');
    expect(within(chatsGroup).getByRole('option', { selected: true }).textContent).toContain(
      'Şifre sıfırlama',
    );
    await user.keyboard('{Enter}');
    await screen.findByText('Hello from Şifre sıfırlama akışı');
    expect(screen.getByTestId('dy-palette').hasAttribute('open')).toBe(false);
    // Remembered for this user.
    expect(readRecent('u1')[0]?.label).toBe('Şifre sıfırlama akışı');
  });

  it('shows an empty state and still offers the AI search', async () => {
    const user = userEvent.setup();
    renderApp({ path: `/chat/${T3}`, initialState: owner, routes: withPrefixes(routes(), mentionsNone) });
    await screen.findByTestId('dy-sohbet-head');
    const input = await openPalette(user);
    await user.type(input, 'qqqqzzzz');
    expect(await screen.findByTestId('dy-palette-empty')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Yapay zeka ile' })).getAllByRole('option')).toHaveLength(
      2,
    );
  });

  it('the master’s @-search fills in what the snapshot does not hold (machines, outputs)', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/chat/${T3}`,
      initialState: owner,
      routes: withPrefixes(routes(), {
        'GET /api/chat/mentions?q=': ok({
          items: [
            { type: 'worker', id: 'atlas-win-01', project: null, label: 'atlas-win-01', detail: 'windows' },
            { type: 'output', id: 'site-1', project: 'acme', label: 'Vitrin sitesi', detail: null },
          ],
        }),
      }),
    });
    await screen.findByTestId('dy-sohbet-head');
    const input = await openPalette(user);
    await user.type(input, 'atlas');
    const machines = await screen.findByRole('group', { name: 'Makineler' });
    expect(within(machines).getByText('atlas-win-01')).toBeTruthy();
    expect(calls(requests, 'GET', '/api/chat/mentions?q=atlas').length).toBeGreaterThan(0);
  });

  it('AI search calls the everywhere endpoint (debounced, 3+ letters), marks meaning matches, opens a result', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/chat/${T3}`,
      initialState: owner,
      routes: withPrefixes(routes(), {
        ...mentionsNone,
        'GET /api/chat/search/everywhere?q=': ok({
          mode: 'semantic',
          fallbackReason: null,
          projects: 2,
          items: [
            {
              kind: 'job_summary',
              id: J1,
              project: 'acme',
              title: 'Ödeme testleri onarıldı',
              snippet: 'flaky test kaldırıldı',
              at: NOW,
              link: `/jobs/${J1}`,
              score: 0.82,
              match: 'semantic',
            },
            {
              kind: 'context_doc',
              id: 'doc-1',
              project: 'acme',
              title: 'Deploy kuralları',
              snippet: 'prod için onay',
              at: NOW,
              link: '/settings/context?namespace=project%3Aacme',
              score: 0.1,
              match: 'keyword',
            },
          ],
        }),
      }),
    });
    await screen.findByTestId('dy-sohbet-head');
    const input = await openPalette(user);
    await user.click(screen.getByTestId('dy-palette-ai'));
    expect(screen.getByTestId('dy-palette-ai').getAttribute('aria-pressed')).toBe('true');
    await user.type(input, 'od');
    expect(calls(requests, 'GET', '/chat/search/everywhere').length).toBe(0);
    await user.type(input, 'eme hatasi');
    const ai = await screen.findByRole('group', { name: 'Yapay zeka ile' });
    await within(ai).findByText('Ödeme testleri onarıldı');
    expect(within(ai).getByText('anlama göre')).toBeTruthy();
    expect(within(ai).getByText('kelimeyle')).toBeTruthy();
    const sent = calls(requests, 'GET', '/chat/search/everywhere');
    expect(sent.at(-1)?.url).toContain(`q=${encodeURIComponent('odeme hatasi')}`);
    // No other search endpoint is hit from AI mode.
    expect(calls(requests, 'GET', '/context/search').length).toBe(0);
    await user.click(within(ai).getByText('Ödeme testleri onarıldı'));
    await waitFor(() => {
      expect(screen.getByTestId('dy-palette').hasAttribute('open')).toBe(false);
    });
  });

  it('"Asistana sor" opens a new Sohbet and sends the question once', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/chat/${T3}`,
      initialState: owner,
      routes: withPrefixes(
        routes({
          'POST /api/chat/threads': ok(thread(T9, 'Yeni sohbet')),
          [`POST /api/chat/threads/${T9}/messages`]: ok({
            message: msg(M1, 1, 'user', 'hangi makineler boşta'),
            turnId: 'turn-1',
            dropped: [],
          }),
          [`GET /api/chat/threads/${T9}`]: detailOf(T9, 'Yeni sohbet'),
          [`POST /api/chat/threads/${T9}/read`]: ok({
            threadId: T9,
            lastReadSeq: 1,
            lastReadAt: NOW,
            unreadCount: 0,
          }),
        }),
        mentionsNone,
      ),
    });
    await screen.findByTestId('dy-sohbet-head');
    const input = await openPalette(user);
    await user.type(input, 'hangi makineler boşta');
    const ask = within(screen.getByRole('group', { name: 'Yapay zeka ile' })).getByRole('option', {
      name: /Asistana sor/,
    });
    await user.click(ask);
    await waitFor(() => {
      expect(calls(requests, 'POST', `/chat/threads/${T9}/messages`)[0]?.body).toMatchObject({
        text: 'hangi makineler boşta',
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls(requests, 'POST', `/chat/threads/${T9}/messages`)).toHaveLength(1);
  });

  it('permissions: a viewer sees no admin settings; lists the master refuses stay empty', async () => {
    const user = userEvent.setup();
    renderApp({
      path: `/chat/${T3}`,
      initialState: viewer,
      routes: withPrefixes(
        routes({
          'GET /api/auth/session': () => ({
            status: 200,
            body: {
              ...(sessionBody() as Record<string, unknown>),
              user: { id: 'u2', username: 'izleyici', role: 'viewer' },
            },
          }),
          'GET /api/jobs?limit=50': () => ({
            status: 403,
            body: { error: 'forbidden', message: 'Forbidden.' },
          }),
          'GET /api/workers': () => ({ status: 403, body: { error: 'forbidden', message: 'Forbidden.' } }),
        }),
        mentionsNone,
      ),
    });
    await screen.findByTestId('dy-sohbet-head');
    const input = await openPalette(user);
    await user.type(input, 'kullanicilar');
    expect(options().some((o) => o.textContent.includes('Kullanıcılar'))).toBe(false);
    await user.clear(input);
    await user.type(input, 'odeme');
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.queryByRole('group', { name: 'İşler' })).toBeNull();
    // Still signed in (a refused list never ends the session).
    expect(screen.getByTestId('dy-palette').hasAttribute('open')).toBe(true);
  });
});
