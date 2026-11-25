// p12-diyalog-w4 (docs/design/p12-diyalog.md §13): the Sohbet leftovers in the Diyalog language — the organize dialogs
// (move to group, tags, new / rename group, manage tags), search by meaning, the bounded stream reopen after a session
// rotation, the archived / unavailable composer lock, the dropped-mention notice, the empty state's suggestions and the
// "answering" status with Stop.
import { act, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { messagesFor } from '@remyral/i18n';
import { suggestions } from '../src/diyalog/chat/DiyalogChat';
import { type Handler, type RecordedRequest, renderApp, sessionBody, stubCookies } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

// p14-i18n-screens-a: the Sohbet words live in the catalog (Turkish unchanged).
const TR = messagesFor('tr');
const ARCHIVED_PLACEHOLDER = TR.chat.thread.archivedPlaceholder;
const UNAVAILABLE_PLACEHOLDER = TR.chat.thread.unavailablePlaceholder;
const SUGGESTIONS_TR = suggestions(TR) as readonly [string, string, string, string];
const droppedText = (n: number): string => TR.chat.thread.dropped({ n });
const FALLBACK_TR = TR.chat.meaning.fallback;

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const T1 = '00000000-0000-4000-8000-0000000000d1';
const T2 = '00000000-0000-4000-8000-0000000000d2';
const G1 = '00000000-0000-4000-8000-0000000000e1';
const G2 = '00000000-0000-4000-8000-0000000000e2';
const TAG1 = '00000000-0000-4000-8000-0000000000f1';
const TAG2 = '00000000-0000-4000-8000-0000000000f2';
const M1 = '00000000-0000-4000-8000-0000000000a1';
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

const ORGANIZE = {
  groups: [{ id: G1, name: 'Deploys', position: 0, collapsed: false, threadCount: 0 }],
  tags: [{ id: TAG1, name: 'urgent', color: 'red', threadCount: 2 }],
  pinned: 0,
};

const ALL = [thread(T1, 'Plain chat', { tagIds: [TAG1] })];

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

const msg = (id: string, seq: number, role: string, content: string) => ({
  id,
  seq,
  role,
  content,
  meta: null,
  turnId: null,
  createdAt: NOW,
});

function detail(over: Record<string, unknown> = {}, threadOver: Record<string, unknown> = {}): Handler {
  return () => ({
    status: 200,
    body: {
      thread: thread(T1, 'Plain chat', threadOver),
      messages: [msg(M1, 1, 'user', 'Hello')],
      drafts: [],
      turn: null,
      watches: [],
      starred: [],
      ...over,
    },
  });
}

const ok =
  (body: unknown = {}): Handler =>
  () => ({ status: 200, body });

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/chat/status': ok(STATUS),
    'GET /api/notifications?limit=20': ok({ items: [], unreadCount: 0, nextCursor: null }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/chat/threads': ok({ items: ALL, organize: ORGANIZE, nextCursor: null }),
    'GET /api/chat/threads?limit=1': ok({ items: ALL, nextCursor: null }),
    [`GET /api/chat/threads/${T1}`]: detail(),
    [`POST /api/chat/threads/${T1}/read`]: ok({
      threadId: T1,
      lastReadSeq: 1,
      lastReadAt: NOW,
      unreadCount: 0,
    }),
    [`GET /api/chat/threads/${T1}/assets?kind=starred&scope=thread&limit=30`]: ok({
      items: [],
      nextCursor: null,
    }),
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/fleet/overview': ok({ workers: [] }),
    ...extra,
  };
}

function calls(requests: RecordedRequest[], method: string, suffix: string): RecordedRequest[] {
  return requests.filter((r) => r.method === method && r.url.endsWith(suffix));
}

function list(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Sohbet listesi' });
}

async function rowMenu(user: ReturnType<typeof userEvent.setup>, title: string): Promise<HTMLElement> {
  await user.click(await within(list()).findByRole('button', { name: `${title} için eylemler` }));
  return screen.getByRole('menu', { name: `${title} için eylemler` });
}

/** A stream the test drives: `fail()` closes it as a browser does when the server refused it. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static all: FakeEventSource[] = [];
  readyState = 0;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(): void {
    // events are not driven here
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  fail(): void {
    this.readyState = 2;
    this.onerror?.();
  }
}

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
  window.localStorage.clear();
  FakeEventSource.all = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog organize dialogs (p12-diyalog-w4)', { timeout: 30_000 }, () => {
  it('move to group: pick a group, or create one and move into it; Escape (cancel) closes', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/chat?yeni=1',
      initialState: signedIn,
      routes: routes({
        [`PUT /api/chat/threads/${T1}/group`]: ok(),
        'POST /api/chat/groups': ok({ id: G2, name: 'Yeni', position: 1, collapsed: false, threadCount: 0 }),
      }),
    });
    await within(await screen.findByRole('navigation', { name: 'Sohbet listesi' })).findByText('Plain chat');
    await user.click(
      within(await rowMenu(user, 'Plain chat')).getByRole('menuitem', { name: 'Gruba taşı…' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Gruba taşı' });
    expect(within(dialog).getByRole('radio', { name: 'Grup yok' })).toHaveProperty('checked', true);
    await user.click(within(dialog).getByRole('radio', { name: 'Deploys' }));
    await waitFor(() => {
      expect(calls(requests, 'PUT', `/chat/threads/${T1}/group`)[0]?.body).toEqual({ groupId: G1 });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Gruba taşı' })).toBeNull();
    });

    await user.click(
      within(await rowMenu(user, 'Plain chat')).getByRole('menuitem', { name: 'Gruba taşı…' }),
    );
    const again = await screen.findByRole('dialog', { name: 'Gruba taşı' });
    const create = within(again).getByRole('button', { name: 'Oluştur ve taşı' });
    expect(create).toHaveProperty('disabled', true);
    await user.type(within(again).getByRole('textbox', { name: 'Yeni grup' }), 'Yeni');
    await user.click(create);
    await waitFor(() => {
      expect(calls(requests, 'POST', '/chat/groups')[0]?.body).toEqual({ name: 'Yeni' });
      expect(calls(requests, 'PUT', `/chat/threads/${T1}/group`)[1]?.body).toEqual({ groupId: G2 });
    });

    await user.click(
      within(await rowMenu(user, 'Plain chat')).getByRole('menuitem', { name: 'Gruba taşı…' }),
    );
    // The native dialog turns Escape into `cancel` (a browser behaviour jsdom does not run); × closes it the same way.
    const last = await screen.findByRole('dialog', { name: 'Gruba taşı' });
    last.dispatchEvent(new Event('cancel', { cancelable: true }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Gruba taşı' })).toBeNull();
    });
  });

  it('tags of a conversation: toggle, create a tag with a colour (Turkish names), save the set', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/chat?yeni=1',
      initialState: signedIn,
      routes: routes({
        'POST /api/chat/tags': ok({ id: TAG2, name: 'deploy', color: 'green', threadCount: 0 }),
        [`PUT /api/chat/threads/${T1}/tags`]: ok(),
      }),
    });
    await within(await screen.findByRole('navigation', { name: 'Sohbet listesi' })).findByText('Plain chat');
    await user.click(within(await rowMenu(user, 'Plain chat')).getByRole('menuitem', { name: 'Etiketler…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Etiketler' });
    expect(within(dialog).getByRole('checkbox', { name: 'urgent' })).toHaveProperty('checked', true);
    // The palette is a radio group with a word per colour (colour never alone).
    const palette = within(dialog).getByRole('group', { name: 'Renk' });
    expect(within(palette).getAllByRole('radio')).toHaveLength(9);
    await user.click(within(palette).getByRole('radio', { name: 'Yeşil' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Yeni etiket' }), 'deploy');
    await user.click(within(dialog).getByRole('button', { name: 'Etiket oluştur' }));
    await waitFor(() => {
      expect(calls(requests, 'POST', '/chat/tags')[0]?.body).toEqual({ name: 'deploy', color: 'green' });
    });
    expect(await within(dialog).findByRole('checkbox', { name: 'deploy' })).toHaveProperty('checked', true);
    await user.click(within(dialog).getByRole('checkbox', { name: 'urgent' }));
    await user.click(within(dialog).getByRole('button', { name: 'Etiketleri kaydet' }));
    await waitFor(() => {
      expect(calls(requests, 'PUT', `/chat/threads/${T1}/tags`)[0]?.body).toEqual({ tagIds: [TAG2] });
    });
  });

  it('new group, rename a group, manage tags (rename, recolour, delete confirmed in the row)', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/chat?yeni=1',
      initialState: signedIn,
      routes: routes({
        'POST /api/chat/groups': ok({
          id: G2,
          name: 'Notlar',
          position: 1,
          collapsed: false,
          threadCount: 0,
        }),
        [`PATCH /api/chat/groups/${G1}`]: ok({ ...ORGANIZE.groups[0], name: 'Yayınlar' }),
        [`PATCH /api/chat/tags/${TAG1}`]: ok({ ...ORGANIZE.tags[0], name: 'acil', color: 'amber' }),
        [`DELETE /api/chat/tags/${TAG1}`]: ok(),
        [`GET /api/chat/threads?pinned=false&group=${G1}&limit=50`]: ok({
          items: [],
          nextCursor: null,
          organize: ORGANIZE,
        }),
      }),
    });
    const nav = await screen.findByRole('navigation', { name: 'Sohbet listesi' });
    await within(nav).findByTestId('group-section');

    await user.click(within(nav).getByRole('button', { name: /Yeni grup/ }));
    const group = await screen.findByRole('dialog', { name: 'Yeni grup' });
    await user.type(within(group).getByRole('textbox', { name: 'Grup adı' }), 'Notlar');
    await user.click(within(group).getByRole('button', { name: 'Grup oluştur' }));
    await waitFor(() => {
      expect(calls(requests, 'POST', '/chat/groups')[0]?.body).toEqual({ name: 'Notlar' });
    });

    await user.click(within(nav).getByRole('button', { name: /^Etiketler$/ }));
    const manage = await screen.findByRole('dialog', { name: 'Etiketleri yönet' });
    const row = within(manage).getByTestId('manage-tag');
    expect(within(row).getByLabelText('2 sohbette')).toBeTruthy();
    await user.click(within(row).getByRole('button', { name: 'urgent etiketini düzenle' }));
    const name = within(row).getByRole('textbox', { name: 'Etiket adı' });
    await user.clear(name);
    await user.type(name, 'acil');
    await user.click(within(row).getByRole('radio', { name: 'Kehribar' }));
    await user.click(within(row).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => {
      expect(calls(requests, 'PATCH', `/chat/tags/${TAG1}`)[0]?.body).toEqual({
        name: 'acil',
        color: 'amber',
      });
    });
    const row2 = within(manage).getByTestId('manage-tag');
    await user.click(within(row2).getByRole('button', { name: /etiketini sil$/ }));
    expect(calls(requests, 'DELETE', `/chat/tags/${TAG1}`)).toHaveLength(0);
    // p18-confirm-dialog: the deletion is confirmed in a dialog, not in the row.
    const ask = await screen.findByTestId('manage-tag-confirm');
    await user.click(within(ask).getByRole('button', { name: /sil$/ }));
    await waitFor(() => {
      expect(calls(requests, 'DELETE', `/chat/tags/${TAG1}`)).toHaveLength(1);
    });
    await user.click(within(manage).getByRole('button', { name: 'Bitti' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Etiketleri yönet' })).toBeNull();
    });
  });
});

describe('Diyalog search by meaning (p12-diyalog-w4)', { timeout: 30_000 }, () => {
  it('debounced, labelled by mode with the fallback reason, hits link to their conversation; errors in words', async () => {
    const user = userEvent.setup();
    const hit = {
      threadId: T2,
      threadTitle: 'Release notes',
      archived: true,
      messageId: M1,
      seq: 1,
      author: 'user',
      attachmentName: null,
      snippet: 'the release went out',
      at: NOW,
    };
    const { requests } = renderApp({
      path: '/chat?yeni=1',
      initialState: signedIn,
      routes: routes({
        'GET /api/chat/threads?q=release': ok({ items: [], organize: ORGANIZE }),
        'GET /api/chat/search?q=release&limit=20': ok({
          mode: 'keyword',
          fallbackReason: 'opted_out',
          items: [hit],
        }),
        'GET /api/chat/threads?q=broken': ok({ items: [], organize: ORGANIZE }),
        'GET /api/chat/search?q=broken&limit=20': () => ({
          status: 503,
          body: { error: 'unavailable', message: 'Search is down.' },
        }),
      }),
    });
    const nav = await screen.findByRole('navigation', { name: 'Sohbet listesi' });
    await within(nav).findByText('Plain chat');
    await user.type(within(nav).getByRole('searchbox', { name: 'Sohbetlerde ara' }), 'release');
    const found = await within(nav).findByTestId('chat-meaning');
    // Debounced: one search for the whole word, none for its prefixes.
    expect(requests.filter((r) => r.url.startsWith('/api/chat/search'))).toHaveLength(1);
    expect(within(found).getByText('Kelimeyle eşleşen mesajlar')).toBeTruthy();
    expect(within(found).getByTestId('chat-meaning-fallback').textContent).toContain(FALLBACK_TR.opted_out);
    const link = within(found).getByTestId('chat-meaning-hit');
    expect(link.getAttribute('href')).toBe(`/chat/${T2}`);
    expect(link.textContent).toContain('(arşivde)');
    expect(link.textContent).toContain('the release went out');

    await user.clear(within(nav).getByRole('searchbox', { name: 'Sohbetlerde ara' }));
    await user.type(within(nav).getByRole('searchbox', { name: 'Sohbetlerde ara' }), 'broken');
    expect((await within(nav).findByText(/Mesajlarda aranamadı/)).textContent).toContain('Search is down.');
  });
});

describe('Diyalog chat leftovers (p12-diyalog-w4)', { timeout: 30_000 }, () => {
  it('a stream refused after a session rotation reopens once the session is live — at most 3 times', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { requests } = renderApp({ path: `/chat/${T1}`, initialState: signedIn, routes: routes() });
    await waitFor(() => {
      expect(FakeEventSource.all).toHaveLength(1);
    });
    for (let n = 1; n <= 3; n++) {
      act(() => {
        FakeEventSource.all.at(-1)?.fail();
      });
      await waitFor(() => {
        expect(FakeEventSource.all).toHaveLength(n + 1);
      });
      expect(FakeEventSource.all[n - 1]?.closed).toBe(true);
    }
    act(() => {
      FakeEventSource.all.at(-1)?.fail();
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(FakeEventSource.all).toHaveLength(4);
    expect(calls(requests, 'GET', '/auth/session').length).toBeGreaterThanOrEqual(3);
  });

  it('a dead session (401 on the re-check) does not reopen the stream', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    let live = true;
    renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: routes({
        'GET /api/auth/session': () =>
          live
            ? { status: 200, body: sessionBody() }
            : { status: 401, body: { error: 'unauthorized', message: 'Authentication required.' } },
      }),
    });
    await waitFor(() => {
      expect(FakeEventSource.all).toHaveLength(1);
    });
    live = false;
    act(() => {
      FakeEventSource.all[0]?.fail();
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(FakeEventSource.all).toHaveLength(1);
  });

  it('an archived conversation locks the composer with the reason', async () => {
    renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: routes({ [`GET /api/chat/threads/${T1}`]: detail({}, { archived: true }) }),
    });
    const field = await screen.findByTestId('dy-composer-field');
    await waitFor(() => {
      expect(field).toHaveProperty('disabled', true);
    });
    expect(field.getAttribute('placeholder')).toBe(ARCHIVED_PLACEHOLDER);
    expect(screen.getByRole('button', { name: 'Dosya ekle' })).toHaveProperty('disabled', true);
  });

  it('the assistant unavailable locks the composer and the suggestions', async () => {
    renderApp({
      path: '/chat?yeni=1',
      initialState: signedIn,
      routes: routes({ 'GET /api/chat/status': ok({ ...STATUS, available: false, code: 'no_worker' }) }),
    });
    const field = await screen.findByTestId('dy-composer-field');
    await waitFor(() => {
      expect(field).toHaveProperty('disabled', true);
    });
    expect(field.getAttribute('placeholder')).toBe(UNAVAILABLE_PLACEHOLDER);
    const empty = await screen.findByTestId('dy-chat-empty');
    expect(within(empty).getByRole('button', { name: SUGGESTIONS_TR[0] })).toHaveProperty('disabled', true);
  });

  it('a fresh conversation shows the four suggestions; one tap creates the conversation and sends it', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/chat?yeni=1',
      initialState: signedIn,
      routes: routes({
        'POST /api/chat/threads': ok(thread(T2, 'Yeni sohbet')),
        [`POST /api/chat/threads/${T2}/messages`]: ok({
          message: msg(M1, 1, 'user', SUGGESTIONS_TR[2]),
          turnId: 'turn-1',
          dropped: [],
        }),
        [`GET /api/chat/threads/${T2}`]: () => ({
          status: 200,
          body: {
            thread: thread(T2, 'Yeni sohbet'),
            messages: [msg(M1, 1, 'user', SUGGESTIONS_TR[2])],
            drafts: [],
            turn: null,
            watches: [],
            starred: [],
          },
        }),
      }),
    });
    const empty = await screen.findByTestId('dy-chat-empty');
    const chips = within(within(empty).getByRole('list', { name: 'Öneriler' })).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual([...SUGGESTIONS_TR]);
    await user.click(within(empty).getByRole('button', { name: SUGGESTIONS_TR[2] }));
    await waitFor(() => {
      expect(calls(requests, 'POST', `/chat/threads/${T2}/messages`)[0]?.body).toMatchObject({
        text: SUGGESTIONS_TR[2],
      });
    });
  });

  it('a fresh conversation can start with a project: the picked project is linked before the first message (owner 2026-10-28)', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/chat?yeni=1',
      initialState: signedIn,
      routes: routes({
        'GET /api/projects': ok({
          items: [
            {
              id: 'cluster-test',
              name: 'cluster-test',
              kind: 'repository',
              createdAt: NOW,
              createdBy: null,
              members: 1,
              myRole: 'owner',
            },
          ],
        }),
        'POST /api/chat/threads': ok(thread(T2, 'Yeni sohbet')),
        [`PUT /api/chat/threads/${T2}/knowledge`]: ok({
          project: 'cluster-test',
          share: true,
          personalShare: false,
          suggestedProject: null,
          sharedWith: [],
          notShared: [],
        }),
        [`POST /api/chat/threads/${T2}/messages`]: ok({
          message: msg(M1, 1, 'user', SUGGESTIONS_TR[0]),
          turnId: 'turn-1',
          dropped: [],
        }),
        [`GET /api/chat/threads/${T2}`]: () => ({
          status: 200,
          body: {
            thread: thread(T2, 'Yeni sohbet'),
            messages: [msg(M1, 1, 'user', SUGGESTIONS_TR[0])],
            drafts: [],
            turn: null,
            watches: [],
            starred: [],
          },
        }),
      }),
    });
    const empty = await screen.findByTestId('dy-chat-empty');
    const picker = await within(empty).findByRole('combobox', { name: 'Proje' });
    await waitFor(() => {
      expect(within(picker).getByRole('option', { name: 'cluster-test' })).toBeTruthy();
    });
    await user.selectOptions(picker, 'cluster-test');
    await user.click(within(empty).getByRole('button', { name: SUGGESTIONS_TR[0] }));
    await waitFor(() => {
      expect(calls(requests, 'POST', `/chat/threads/${T2}/messages`)).toHaveLength(1);
    });
    const linked = calls(requests, 'PUT', `/chat/threads/${T2}/knowledge`);
    expect(linked[0]?.body).toEqual({ project: 'cluster-test' });
    const order = requests.map((r) => `${r.method} ${r.url}`);
    expect(order.findIndex((x) => x.endsWith(`/chat/threads/${T2}/knowledge`))).toBeLessThan(
      order.findIndex((x) => x.endsWith(`/chat/threads/${T2}/messages`)),
    );
  });

  it('mentions the master left out are named after sending; the next send clears the notice', async () => {
    const user = userEvent.setup();
    let dropped: unknown[] = [
      { type: 'job', id: 'j-1', reason: 'not_visible' },
      { type: 'project', id: 'p-1', reason: 'not_found' },
    ];
    renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: routes({
        [`POST /api/chat/threads/${T1}/messages`]: () => ({
          status: 200,
          body: { message: msg(M1, 2, 'user', 'x'), turnId: 'turn-1', dropped },
        }),
      }),
    });
    const field = await screen.findByTestId('dy-composer-field');
    await user.type(field, 'Bunlara bak{Enter}');
    const notice = await screen.findByTestId('mentions-dropped');
    expect(notice.textContent).toBe(droppedText(2));
    dropped = [];
    await user.type(field, 'Tekrar{Enter}');
    await waitFor(() => {
      expect(screen.queryByTestId('mentions-dropped')).toBeNull();
    });
  });

  it('while a turn runs: "Remyral yanıtlıyor…" is announced and Stop cancels the turn', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: routes({
        [`GET /api/chat/threads/${T1}`]: detail({
          turn: { id: 'turn-1', state: 'running', text: 'Bakıyorum' },
        }),
        [`POST /api/chat/threads/${T1}/cancel`]: ok(),
      }),
    });
    await waitFor(() => {
      expect(screen.getByTestId('dy-answering').textContent).toBe('Remyral yanıtlıyor…');
    });
    expect(screen.getByTestId('dy-answering').getAttribute('aria-live')).toBe('polite');
    await user.click(screen.getByRole('button', { name: 'Yanıtı durdur' }));
    await waitFor(() => {
      expect(calls(requests, 'POST', `/chat/threads/${T1}/cancel`)).toHaveLength(1);
    });
  });
});
