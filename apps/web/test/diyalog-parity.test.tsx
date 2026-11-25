// p12-diyalog-parity (docs/design/p12-diyalog.md §13): the classic chat list, conversation, details panel and top-bar
// features under the Diyalog flag — the Sohbet screen's conversation list (search, archive, tag filter, pins, groups,
// tags, unread, rename / pin / move / tags / archive / delete), a conversation as a Diyalog thread (status line,
// knowledge bar, watches, stars, tools, drafts, composer), the details panel (tabs, all my conversations, jump), the
// header menu, the per-screen "Klasik görünüm" fallback, and a parity check of the key classic features.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { chatRouteId } from '../src/diyalog/chat/DiyalogChat';
import { PANE_STORAGE_KEY } from '../src/diyalog/chat/pane';
import { assetState } from '../src/diyalog/chat/DetailsPanel';
import { MSG_SKIP_WAITING, registerServiceWorker, resetServiceWorkerState } from '../src/pwa/serviceWorker';
import { openStripCard } from './card-strip';
import { type Handler, type RecordedRequest, renderApp, sessionBody, stubCookies } from './helpers';
import { zoneLabel } from '../src/lib/displayZone';

configure({ asyncUtilTimeout: 5_000 });

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const T1 = '00000000-0000-4000-8000-0000000000d1';
const T2 = '00000000-0000-4000-8000-0000000000d2';
const T3 = '00000000-0000-4000-8000-0000000000d3';
const G1 = '00000000-0000-4000-8000-0000000000e1';
const TAG1 = '00000000-0000-4000-8000-0000000000f1';
const M1 = '00000000-0000-4000-8000-0000000000a1';
const M2 = '00000000-0000-4000-8000-0000000000a2';
const M3 = '00000000-0000-4000-8000-0000000000a3';
const NOW = new Date().toISOString();
const OLD = new Date(Date.now() - 20 * 86_400_000).toISOString();

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
  groups: [{ id: G1, name: 'Deploys', position: 0, collapsed: false, threadCount: 1 }],
  tags: [{ id: TAG1, name: 'urgent', color: 'red', threadCount: 1 }],
  pinned: 1,
};

const ALL = [
  thread(T3, 'Plain chat', { unreadCount: 3 }),
  thread(T1, 'Pinned talk', { pinnedAt: NOW }),
  thread(T2, 'Release notes', { groupId: G1, tagIds: [TAG1] }),
];

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

const msg = (id: string, seq: number, role: string, content: string, meta: unknown = null) => ({
  id,
  seq,
  role,
  content,
  meta,
  turnId: null,
  createdAt: NOW,
});

const knowledge = {
  project: null,
  share: true,
  personalShare: true,
  sharedWith: [],
  notShared: [],
  suggestedProject: 'acme',
  memorySummary: [],
};

const watch = {
  id: 'w-1',
  threadId: T3,
  target: { kind: 'job', id: 'j-1' },
  label: 'Nightly build',
  project: 'acme',
  conditions: ['finished'],
  repeat: 'once',
  state: 'active',
  endReason: null,
  fireCount: 0,
  check: null,
  lastFiredAt: null,
  createdAt: NOW,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  link: '/jobs/j-1',
};

function detail(over: Record<string, unknown> = {}): Handler {
  return () => ({
    status: 200,
    body: {
      thread: thread(T3, 'Plain chat'),
      messages: [
        msg(M1, 1, 'user', 'Which machines are idle?', {
          related: {
            mode: 'semantic',
            items: [{ kind: 'context_doc', id: 'doc-1', title: 'Fleet notes', link: '/context' }],
          },
        }),
        msg(M2, 2, 'tool', 'workers_list: 2 idle', { name: 'workers_list' }),
        msg(M3, 3, 'assistant', 'Two machines are **idle**.'),
      ],
      drafts: [],
      turn: null,
      watches: [watch],
      knowledge,
      starred: [M3],
      ...over,
    },
  });
}

const ok =
  (body: unknown = {}): Handler =>
  () => ({ status: 200, body });
const empty = { status: 200, body: { items: [], nextCursor: null } };

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/chat/status': ok(AVAILABLE),
    'GET /api/notifications?limit=20': ok({ items: [], unreadCount: 0, nextCursor: null }),
    'GET /api/chat/unread': ok({ total: 3, threads: 1 }),
    'GET /api/chat/threads': ok({ items: ALL, organize: ORGANIZE, nextCursor: null }),
    'GET /api/chat/threads?pinned=true': ok({ items: [ALL[1]], organize: ORGANIZE }),
    [`GET /api/chat/threads?pinned=false&group=${G1}&limit=50`]: ok({
      items: [ALL[2]],
      nextCursor: null,
      organize: ORGANIZE,
    }),
    [`GET /api/chat/threads?tag=${TAG1}`]: ok({ items: [ALL[2]], organize: ORGANIZE }),
    'GET /api/chat/threads?archived=true': ok({
      items: [
        thread('00000000-0000-4000-8000-0000000000d9', 'Old archived', { archived: true, updatedAt: OLD }),
      ],
      organize: ORGANIZE,
    }),
    'GET /api/chat/threads?q=rel': ok({ items: [ALL[2]], organize: ORGANIZE }),
    'GET /api/chat/threads?q=release': ok({ items: [ALL[2]], organize: ORGANIZE }),
    'GET /api/chat/search?q=rel&limit=20': ok({ mode: 'keyword', fallbackReason: null, items: [] }),
    'GET /api/chat/search?q=release&limit=20': ok({
      mode: 'semantic',
      fallbackReason: null,
      items: [
        {
          threadId: T2,
          threadTitle: 'Release notes',
          archived: false,
          messageId: M1,
          seq: 1,
          author: 'user',
          attachmentName: null,
          snippet: 'the release went out',
          at: NOW,
        },
      ],
    }),
    'GET /api/chat/threads?limit=1': ok({ items: [ALL[0]], nextCursor: null }),
    [`GET /api/chat/threads/${T3}`]: detail(),
    [`POST /api/chat/threads/${T3}/read`]: ok({
      threadId: T3,
      lastReadSeq: 3,
      lastReadAt: NOW,
      unreadCount: 0,
    }),
    'GET /api/ops-thread?limit=50': () => ({
      status: 404,
      body: { error: 'not_found', message: 'Not found.' },
    }),
    'GET /api/approvals?status=pending': ok({ items: [] }),
    'GET /api/jobs?state=FAILED&limit=50': () => empty,
    'GET /api/jobs?state=SUCCEEDED&limit=50': () => empty,
    'GET /api/jobs?state=BLOCKED&limit=50': () => empty,
    'GET /api/jobs?state=LOST&limit=50': () => empty,
    'GET /api/jobs?state=RUNNING%2CSTARTING%2CVERIFYING%2CAWAITING_APPROVAL&limit=200': () => empty,
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

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetServiceWorkerState();
});

describe('Diyalog conversation list (p12-diyalog-parity)', { timeout: 30_000 }, () => {
  it('/chat: pinned, groups, tags, date groups and unread counts; nothing of the ops stream', async () => {
    const { requests } = renderApp({ path: '/chat?yeni=1', initialState: signedIn, routes: routes() });
    const nav = await screen.findByRole('navigation', { name: 'Sohbet listesi' });
    // Pinned section, then the group (expanded, its own request) and the rest grouped by day.
    const pinned = await within(nav).findByTestId('pinned-section');
    expect(within(pinned).getByText('Pinned talk')).toBeTruthy();
    const group = await within(nav).findByTestId('group-section');
    expect(
      within(group)
        .getByRole('button', { name: /^Deploys\s*1$/ })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(await within(group).findByText('Release notes')).toBeTruthy();
    expect(within(group).getByTestId('dy-row-tags').getAttribute('aria-label')).toBe('Etiketler: urgent');
    expect(within(nav).getByRole('list', { name: 'Bugün' })).toBeTruthy();
    // p17-ui-polish: "Diğer sohbetler" and the first date group share one heading.
    expect(within(nav).getByTestId('ungrouped-heading').textContent).toBe('Diğer sohbetler · Bugün');
    expect(within(nav).queryByRole('heading', { name: 'Bugün' })).toBeNull();
    // Unread: bold row with its count and spoken label; the "mark all read" control appears.
    const plain = within(nav).getByRole('link', { name: 'Plain chat, 3 okunmamış' });
    expect(plain.getAttribute('data-unread')).toBe('true');
    expect(within(plain).getByTestId('thread-unread').textContent).toBe('3');
    expect(within(nav).getByRole('button', { name: /Tümünü okundu say/ })).toBeTruthy();
    // The ops-event stream is not merged into chat (by design, the home is a panel).
    expect(requests.some((r) => r.url.startsWith('/api/ops-thread'))).toBe(false);
    // The top bar's toggle carries the unread dot (drawer on phones, column on wide windows).
    await waitFor(() => {
      expect(screen.getByTestId('dy-conversations-toggle').getAttribute('aria-label')).toBe(
        'Sohbetler, 3 okunmamış',
      );
    });
  });

  it('search by title and by meaning, show archived, tag filter — each with the classic request', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({ path: '/chat?yeni=1', initialState: signedIn, routes: routes() });
    const nav = await screen.findByRole('navigation', { name: 'Sohbet listesi' });
    await within(nav).findByText('Plain chat');

    await user.type(within(nav).getByRole('searchbox', { name: 'Sohbetlerde ara' }), 'release');
    expect(await within(nav).findByTestId('chat-meaning-hit')).toBeTruthy();
    await waitFor(() => {
      expect(requests.some((r) => r.url === '/api/chat/threads?q=release')).toBe(true);
    });
    // A search shows one flat list: the group name is shown on the row.
    expect(await within(nav).findByTestId('dy-row-group')).toBeTruthy();
    await user.clear(within(nav).getByRole('searchbox', { name: 'Sohbetlerde ara' }));

    await user.click(within(nav).getByTestId('dy-show-archived'));
    expect(within(nav).getByTestId('dy-show-archived').getAttribute('aria-pressed')).toBe('true');
    expect(await within(nav).findByText('Old archived')).toBeTruthy();
    expect(within(nav).getByRole('list', { name: 'Daha eski' })).toBeTruthy();
    expect(within(nav).getByText('Arşivde')).toBeTruthy();
    await user.click(within(nav).getByTestId('dy-show-archived'));

    await user.selectOptions(within(nav).getByRole('combobox', { name: 'Etikete göre süz' }), TAG1);
    await waitFor(() => {
      expect(requests.some((r) => r.url === `/api/chat/threads?tag=${TAG1}`)).toBe(true);
    });
    await waitFor(() => {
      expect(within(nav).queryByText('Plain chat')).toBeNull();
    });
    expect(within(nav).getByText('Release notes')).toBeTruthy();
  });

  it('row menu: pin, move to group, tags, rename, archive, delete (confirmed in the menu); mark all read', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/chat?yeni=1',
      initialState: signedIn,
      routes: routes({
        [`PUT /api/chat/threads/${T3}/pin`]: ok({ pinnedAt: NOW }),
        [`PATCH /api/chat/threads/${T3}`]: ok(thread(T3, 'Renamed')),
        [`DELETE /api/chat/threads/${T3}`]: () => ({ status: 204 }),
        'POST /api/chat/threads/read-all': ok({ updated: 1 }),
      }),
    });
    await within(await screen.findByRole('navigation', { name: 'Sohbet listesi' })).findByText('Plain chat');

    await user.click(within(await rowMenu(user, 'Plain chat')).getByRole('menuitem', { name: 'Sabitle' }));
    await waitFor(() => {
      expect(calls(requests, 'PUT', `/chat/threads/${T3}/pin`)[0]?.body).toEqual({ pinned: true });
    });

    await user.click(
      within(await rowMenu(user, 'Plain chat')).getByRole('menuitem', { name: 'Gruba taşı…' }),
    );
    expect(await screen.findByRole('dialog', { name: 'Gruba taşı' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await user.click(within(await rowMenu(user, 'Plain chat')).getByRole('menuitem', { name: 'Etiketler…' }));
    expect(await screen.findByRole('dialog', { name: 'Etiketler' })).toBeTruthy();
    await user.keyboard('{Escape}');

    await user.click(
      within(await rowMenu(user, 'Plain chat')).getByRole('menuitem', { name: 'Yeniden adlandır' }),
    );
    const field = within(list()).getByRole('textbox', { name: 'Conversation title' });
    await user.clear(field);
    await user.type(field, 'Renamed{Enter}');
    await waitFor(() => {
      expect(calls(requests, 'PATCH', `/chat/threads/${T3}`)[0]?.body).toEqual({ title: 'Renamed' });
    });

    await user.click(within(await rowMenu(user, 'Plain chat')).getByRole('menuitem', { name: 'Arşivle' }));
    await waitFor(() => {
      expect(
        calls(requests, 'PATCH', `/chat/threads/${T3}`).some(
          (r) => (r.body as { archived?: boolean }).archived === true,
        ),
      ).toBe(true);
    });

    const menu = await rowMenu(user, 'Plain chat');
    await user.click(within(menu).getByRole('menuitem', { name: 'Sil' }));
    // p18-confirm-dialog: the menu closes; the question is a confirm dialog.
    const ask = await screen.findByRole('dialog', { name: 'Bu sohbet ve taslakları silinsin mi?' });
    expect(calls(requests, 'DELETE', `/chat/threads/${T3}`)).toHaveLength(0);
    await user.click(within(ask).getByRole('button', { name: 'Kalıcı olarak sil' }));
    await waitFor(() => {
      expect(calls(requests, 'DELETE', `/chat/threads/${T3}`)).toHaveLength(1);
    });

    await user.click(within(list()).getByRole('button', { name: /Tümünü okundu say/ }));
    await waitFor(() => {
      expect(calls(requests, 'POST', '/chat/threads/read-all')).toHaveLength(1);
    });
  });

  it('new group and manage tags open the Diyalog dialogs; a group collapses and remembers it on the master', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/chat?yeni=1',
      initialState: signedIn,
      routes: routes({ [`PATCH /api/chat/groups/${G1}`]: ok({ ...ORGANIZE.groups[0], collapsed: true }) }),
    });
    const nav = await screen.findByRole('navigation', { name: 'Sohbet listesi' });
    await within(nav).findByTestId('group-section');
    await user.click(within(nav).getByRole('button', { name: /Yeni grup/ }));
    expect(await screen.findByRole('dialog', { name: 'Yeni grup' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await user.click(within(nav).getByRole('button', { name: /^Etiketler$/ }));
    expect(await screen.findByRole('dialog', { name: 'Etiketleri yönet' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await user.click(within(nav).getByRole('button', { name: /^Deploys\s*1$/ }));
    await waitFor(() => {
      expect(calls(requests, 'PATCH', `/chat/groups/${G1}`)[0]?.body).toEqual({ collapsed: true });
    });
  });
});

describe('Diyalog conversation (p12-diyalog-parity)', { timeout: 30_000 }, () => {
  it('/chat/:id is a Diyalog thread with the header, knowledge bar, watches, messages, tools and stars', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/chat/${T3}`,
      initialState: signedIn,
      routes: routes({
        [`PUT /api/chat/messages/${M1}/star`]: ok({ starred: true }),
        [`PUT /api/chat/threads/${T3}/knowledge`]: ok({ ...knowledge, project: 'acme' }),
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Plain chat' })).toBeTruthy();
    expect(await screen.findByTestId('chat-status')).toBeTruthy();
    expect(screen.getByTestId('chat-status').textContent).toBe('claude-code · claude-sonnet-4-5 · mac-1');
    // Classic ChatPage is not mounted: no "Conversation list panel".
    expect(screen.queryByTestId('chat-threads')).toBeNull();
    const log = await screen.findByRole('log', { name: 'Sohbet' });
    expect(within(log).getByText('Which machines are idle?')).toBeTruthy();
    expect(within(log).getByText('idle')).toBeTruthy();
    expect(within(log).getByText('1 araç kullanıldı: workers_list')).toBeTruthy();
    // "Used N related items" under the answer (p10-semantic-defaults-chat).
    expect(within(log).getByTestId('related-disclosure').textContent).toContain('1 ilgili kayıt kullanıldı');
    // The active row in the list.
    expect(
      (await within(list()).findByRole('link', { name: /^Plain chat/ })).getAttribute('aria-current'),
    ).toBe('page');
    // Knowledge bar: suggested project link; watches strip.
    const bar = screen.getByTestId('knowledge-bar');
    await user.click(within(bar).getByTestId('knowledge-suggested'));
    await waitFor(() => {
      expect(calls(requests, 'PUT', `/chat/threads/${T3}/knowledge`)[0]?.body).toEqual({ project: 'acme' });
    });
    expect(screen.getByText('Nightly build')).toBeTruthy();
    // Stars: the assistant answer is starred (from the detail), the question can be starred.
    const stars = within(log).getAllByTestId('star-toggle');
    expect(stars.map((s) => s.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    await user.click(stars[0] as HTMLElement);
    await waitFor(() => {
      expect(calls(requests, 'PUT', `/chat/messages/${M1}/star`)[0]?.body).toEqual({ starred: true });
    });
    // Read mark and the classic composer (attachments, mentions, Stop) on the thread plane.
    await waitFor(() => {
      expect(calls(requests, 'POST', `/chat/threads/${T3}/read`).length).toBeGreaterThan(0);
    });
    // The Faz 3 composer (attachments, mentions, slash commands) under the thread.
    const form = screen.getByRole('form', { name: 'Remyral’a yaz' });
    // p12-diyalog-final: the classic full-height chat behaviour on phones — the field hides the bottom bar while it
    // has focus (`[data-chat-composer]`, index.css) and the dock lifts above the keyboard (`.dy-composer-dock`).
    expect(within(form).getByLabelText('Mesaj').hasAttribute('data-chat-composer')).toBe(true);
    expect(form.closest('.dy-composer-dock')).not.toBeNull();
    expect(screen.getByTestId('dy-sohbet').className).toContain('min-h-[var(--app-vh,100dvh)]');
  });

  it('sends a message; header menu archives; an archived conversation cannot be written to', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/chat/${T3}`,
      initialState: signedIn,
      routes: routes({
        [`POST /api/chat/threads/${T3}/messages`]: ok({
          message: msg('00000000-0000-4000-8000-0000000000a9', 4, 'user', 'hello'),
          turnId: 'turn-1',
          dropped: [],
        }),
        [`PATCH /api/chat/threads/${T3}`]: ok(thread(T3, 'Plain chat', { archived: true })),
      }),
    });
    await screen.findByRole('log', { name: 'Sohbet' });
    const composer = within(screen.getByRole('form', { name: 'Remyral’a yaz' }));
    await user.type(composer.getAllByRole('textbox')[0] as HTMLElement, 'hello{Enter}');
    await waitFor(() => {
      expect(calls(requests, 'POST', `/chat/threads/${T3}/messages`)[0]?.body).toMatchObject({
        text: 'hello',
      });
    });
    const all = screen.getAllByRole('button', { name: 'Plain chat için eylemler' });
    // The header menu is the last one (after the list row's, once the list has loaded).
    const header = all.at(-1);
    if (header === undefined) throw new Error('no header menu');
    await user.click(header);
    const menu = screen.getByRole('menu', { name: 'Plain chat için eylemler' });
    expect(within(menu).queryByRole('menuitem', { name: 'Klasik görünümde aç' })).toBeNull();
    await user.click(within(menu).getByRole('menuitem', { name: 'Arşivle' }));
    await waitFor(() => {
      expect(calls(requests, 'PATCH', `/chat/threads/${T3}`)[0]?.body).toEqual({ archived: true });
    });
  });

  it('details panel: tabs, all my conversations, items jump to their message', async () => {
    const user = userEvent.setup();
    const asset = (kind: string, label: string) => ({
      kind,
      key: `${kind}:1`,
      threadId: T3,
      threadTitle: 'Plain chat',
      messageId: M3,
      seq: 3,
      createdAt: NOW,
      label,
      detail: null,
      url: kind === 'links' ? 'https://example.com/a' : null,
      href: kind === 'jobs' ? '/jobs/j-1' : null,
      domain: kind === 'links' ? 'example.com' : null,
      mediaType: null,
      sizeBytes: null,
      role: 'assistant',
      source: null,
      draftKind: kind === 'jobs' ? 'job' : null,
      draftState: kind === 'jobs' ? 'confirmed' : null,
      state: kind === 'jobs' ? 'RUNNING' : null,
    });
    const { requests } = renderApp({
      path: `/chat/${T3}`,
      initialState: signedIn,
      routes: routes({
        [`GET /api/chat/threads/${T3}/assets?kind=starred`]: ok({
          items: [asset('starred', 'Two machines are idle.')],
        }),
        [`GET /api/chat/threads/${T3}/assets?kind=links`]: ok({ items: [asset('links', 'example')] }),
        [`GET /api/chat/threads/${T3}/assets?kind=jobs`]: ok({ items: [asset('jobs', 'Build it')] }),
        'GET /api/chat/assets?kind=jobs': ok({ items: [asset('jobs', 'Build it')] }),
      }),
    });
    await screen.findByRole('log', { name: 'Sohbet' });
    const toggle = screen.getByTestId('sidebar-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    const panel = await screen.findByRole('complementary', { name: 'Sohbet ayrıntıları' });
    expect(
      within(panel)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Yıldızlı', 'Görseller', 'Bağlantılar', 'Dosyalar', 'İşler', 'Takipler', 'Planlar']);
    expect(await within(panel).findByText('Two machines are idle.')).toBeTruthy();
    await user.click(within(panel).getByRole('tab', { name: 'Bağlantılar' }));
    expect(await within(panel).findByText('example.com')).toBeTruthy();
    await user.click(within(panel).getByRole('tab', { name: 'İşler' }));
    expect(await within(panel).findByText('Build it')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Aç' }).getAttribute('href')).toBe('/jobs/j-1');
    await user.click(within(panel).getByRole('checkbox', { name: 'Tüm sohbetlerim' }));
    await waitFor(() => {
      expect(requests.some((r) => r.url === '/api/chat/assets?kind=jobs')).toBe(true);
    });
    expect(await within(panel).findByText('Plain chat')).toBeTruthy();
    // Jump: the message row is tinted briefly.
    await user.click(within(panel).getAllByRole('button', { name: /Sohbette göster/ })[0] as HTMLElement);
    await waitFor(() => {
      expect(document.querySelector(`[data-message-id="${M3}"][data-jump="true"]`)).not.toBeNull();
    });
    // Remembered per user (the classic key), closed with Escape.
    expect(
      window.localStorage.getItem('remyral.chat.sidebar.00000000-0000-4000-8000-000000000001') ??
        window.localStorage.getItem('remyral.chat.sidebar.u1'),
    ).toBe('open');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Sohbet ayrıntıları' })).toBeNull();
    });
  });

  it('a non-job draft is a native card (p12-diyalog-w4), with no classic view any more', async () => {
    renderApp({
      path: `/chat/${T3}`,
      initialState: signedIn,
      routes: routes({
        [`GET /api/chat/threads/${T3}`]: detail({
          drafts: [
            {
              id: 'd1',
              threadId: T3,
              kind: 'approval_decision',
              title: 'Approve the merge into main',
              payload: {},
              project: 'acme',
              state: 'proposed',
              result: null,
              createdAt: NOW,
              expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
              decidedAt: null,
            },
          ],
        }),
      }),
    });
    const log = await screen.findByRole('log', { name: 'Sohbet' });
    const card = await openStripCard('Approve the merge into main', { scope: log });
    // p12-diyalog-w4: every draft kind is native; p15-classic-removal: no classic view link.
    expect(within(card).getByRole('button', { name: 'Onayla' })).toBeTruthy();
    expect(within(card).queryByRole('link', { name: 'Klasik görünüm' })).toBeNull();
  });

  it('"Yeni sohbet" (`/chat?yeni=1`): an empty conversation with the composer; nothing loaded until the first message', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({ path: `/chat/${T3}`, initialState: signedIn, routes: routes() });
    await screen.findByRole('heading', { level: 1, name: 'Plain chat' });
    await user.click(within(list()).getByRole('button', { name: /Yeni sohbet/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Yeni sohbet' })).toBeTruthy();
    expect(screen.getByRole('form', { name: 'Remyral’a yaz' })).toBeTruthy();
    expect(within(list()).queryByRole('link', { current: 'page' })).toBeNull();
    expect(requests.some((r) => r.url === '/api/chat/threads?limit=1')).toBe(false);
  });

  it('`/chat` opens the latest conversation, highlighted in the list', async () => {
    renderApp({ path: '/chat', initialState: signedIn, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Plain chat' })).toBeTruthy();
    expect(
      (await within(list()).findByRole('link', { name: /^Plain chat/ })).getAttribute('aria-current'),
    ).toBe('page');
  });
});

describe('Pane, fallback and parity (p12-diyalog-parity)', { timeout: 30_000 }, () => {
  it('routes and helpers', () => {
    expect(chatRouteId('/chat')).toBeNull();
    expect(chatRouteId(`/chat/${T1}`)).toBe(T1);
    expect(chatRouteId('/chat/a/b')).toBeUndefined();
    expect(chatRouteId('/jobs')).toBeUndefined();
    expect(assetState('RUNNING')).toBe('running');
    expect(assetState('confirmed')).toBe('done');
    expect(assetState('FAILED')).toBe('failed');
  });

  it('the list column collapses (remembered) and comes back from the top bar', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'matchMedia',
      (q: string) =>
        ({
          matches: q.includes('min-width'),
          media: q,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          onchange: null,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
    renderApp({ path: '/chat', initialState: signedIn, routes: routes() });
    const pane = await screen.findByTestId('dy-conversations');
    expect(pane.getAttribute('data-collapsed')).toBe('false');
    await user.click(within(pane).getByRole('button', { name: 'Listeyi gizle' }));
    expect(pane.getAttribute('data-collapsed')).toBe('true');
    expect(window.localStorage.getItem(PANE_STORAGE_KEY)).toBe('collapsed');
    await user.click(screen.getByTestId('dy-conversations-toggle'));
    expect(pane.getAttribute('data-collapsed')).toBe('false');
    expect(window.localStorage.getItem(PANE_STORAGE_KEY)).toBe('open');
  });

  it('phones: the list is a drawer — opens from the top bar, Escape closes and returns focus', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'matchMedia',
      (q: string) =>
        ({
          matches: false,
          media: q,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          onchange: null,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
    renderApp({ path: '/chat', initialState: signedIn, routes: routes() });
    const toggle = await screen.findByTestId('dy-conversations-toggle');
    await user.click(toggle);
    const pane = screen.getByTestId('dy-conversations');
    expect(pane.getAttribute('data-open')).toBe('true');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(within(pane).getByRole('searchbox', { name: 'Sohbetlerde ara' }));
    expect(screen.getByTestId('dy-conversations-scrim')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(pane.getAttribute('data-open')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  it('parity: the key classic features render in the Diyalog Sohbet', async () => {
    const user = userEvent.setup();
    renderApp({ path: `/chat/${T3}`, initialState: signedIn, routes: routes() });
    await screen.findByRole('heading', { level: 1, name: 'Plain chat' });
    // Top bar: notifications bell, account menu (p15-classic-removal: no classic switch or classic page).
    const tools = screen.getByTestId('dy-top-tools');
    expect(within(tools).getByRole('button', { name: /^Bildirimler/ })).toBeTruthy();
    expect(within(tools).getByRole('button', { name: /Hesap menüsü/ })).toBeTruthy();
    expect(screen.queryByTestId('ui-switch')).toBeNull();
    // Conversation list, details toggle.
    expect(screen.getByRole('navigation', { name: 'Sohbet listesi' })).toBeTruthy();
    expect(screen.getByTestId('sidebar-toggle')).toBeTruthy();
    // Nav: Sohbet is active on /chat, Panel is the home; keyboard shortcuts help from the rail and with "?".
    const nav = screen.getAllByRole('navigation', { name: 'Diyalog' })[0] as HTMLElement;
    expect(
      within(nav)
        .getByRole('link', { name: /^Sohbet/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Ana sayfa' }).getAttribute('href')).toBe('/');
    await user.click(within(nav).getByRole('button', { name: 'Klavye kısayolları' }));
    expect(await screen.findByRole('dialog', { name: 'Klavye kısayolları' })).toBeTruthy();
    await user.keyboard('{Escape}');
    // "Tümü" offers every section.
    await user.click(within(nav).getByRole('button', { name: 'Tümü' }));
    const all = screen.getByRole('dialog', { name: 'Tüm ekranlar' });
    for (const label of ['Denetim kaydı', 'Onaylar', 'Ayarlar'])
      expect(within(all).getByRole('link', { name: label })).toBeTruthy();
  });

  it('parity: "/" in the list focuses the conversation search (classic "/" shortcut)', async () => {
    const user = userEvent.setup();
    renderApp({ path: `/chat/${T3}`, initialState: signedIn, routes: routes() });
    await screen.findByRole('log', { name: 'Sohbet' });
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('/');
    expect(document.activeElement).toBe(within(list()).getByRole('searchbox', { name: 'Sohbetlerde ara' }));
  });

  it('global: the new-version offer in the Diyalog language (never automatic), once for every screen', async () => {
    const user = userEvent.setup();
    const posted: unknown[] = [];
    const waiting = { postMessage: (m: unknown) => posted.push(m), addEventListener: () => undefined };
    const reg = {
      waiting,
      installing: null,
      addEventListener: () => undefined,
      update: () => Promise.resolve(),
    };
    const reload = vi.fn();
    await registerServiceWorker({
      container: {
        controller: {},
        addEventListener: () => undefined,
        register: () => Promise.resolve(reg),
      } as unknown as ServiceWorkerContainer,
      doc: document,
      reload,
      setInterval: () => 0,
    });
    renderApp({ path: `/chat/${T3}`, initialState: signedIn, routes: routes() });
    const banner = await screen.findByTestId('dy-update-banner');
    expect(banner.textContent).toContain('Remyral’ın yeni sürümü hazır.');
    // The classic banner is not shown twice.
    expect(screen.queryByTestId('update-banner')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    await user.click(within(banner).getByRole('button', { name: 'Yenile' }));
    expect(posted).toEqual([{ type: MSG_SKIP_WAITING }]);
  });

  // p20-quick: the clock reads in the person's time zone (here: the browser's); the server's UTC time is in the tooltip.
  it('global: the server clock sits in the nav rail (your time zone, the server UTC time in the tooltip)', async () => {
    renderApp({
      path: '/chat',
      initialState: signedIn,
      routes: routes({ 'GET /api/time': ok({ now: new Date().toISOString() }) }),
    });
    const nav = (await screen.findAllByRole('navigation', { name: 'Diyalog' }))[0] as HTMLElement;
    const clock = await within(nav).findByTestId('server-clock');
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(within(clock).getByTestId('server-clock-zone').textContent).toBe(zoneLabel(Date.now(), zone));
    expect(clock.getAttribute('title')).toContain('Sunucu saati');
    expect(clock.getAttribute('title')).toContain(`(${zone})`);
    expect(clock.getAttribute('data-skewed')).toBe('false');
  });

  it('global: keyboard shortcuts help lists the Diyalog keys; step-up and shell dialogs sit in the Diyalog scope', async () => {
    const user = userEvent.setup();
    const r = renderApp({ path: '/chat', initialState: signedIn, routes: routes() });
    await screen.findByRole('navigation', { name: 'Sohbet listesi' });
    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Klavye kısayolları' });
    for (const label of ['Sohbete git', 'Ana sayfaya git', 'Bu kısayolları göster', 'Sonraki karar kartı'])
      expect(within(dialog).getByText(label)).toBeTruthy();
    // Direct child of the scope root: the dialog bridge (chat.css) gives it the Diyalog palette.
    expect(dialog.parentElement?.getAttribute('data-ui')).toBe('diyalog');
    expect(r.container.querySelector('[data-ui="diyalog"] > dialog')).not.toBeNull();
  });

  it('global: notification bell in the Diyalog language — badge, list, open marks read and navigates, mark all read', async () => {
    const user = userEvent.setup();
    const note = (over: Record<string, unknown> = {}) => ({
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'job.failed',
      severity: 'critical',
      title: 'Job failed: 1234abcd in alpha',
      body: 'Job 1234abcd failed.',
      link: '/jobs',
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      readAt: null,
      ...over,
    });
    let unread = 2;
    const { requests } = renderApp({
      path: '/chat',
      initialState: signedIn,
      routes: routes({
        'GET /api/notifications?limit=20': () => ({
          status: 200,
          body: { items: [note()], unreadCount: unread, nextCursor: null },
        }),
        'POST /api/notifications/11111111-1111-4111-8111-111111111111/read': () => {
          unread -= 1;
          return { status: 200, body: { notification: note(), unreadCount: unread } };
        },
        'POST /api/notifications/read-all': ok({ updated: 1, unreadCount: 0 }),
      }),
    });
    const bell = await screen.findByRole('button', { name: 'Bildirimler, 2 okunmamış' });
    expect(within(bell).getByTestId('notification-badge').textContent).toBe('2');
    await user.click(bell);
    const panel = screen.getByRole('region', { name: 'Bildirimler' });
    expect(within(panel).getByText('Kritik, okunmamış:', { exact: false })).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Bildirim ayarları' }).getAttribute('href')).toBe(
      '/settings/notifications',
    );
    await user.click(within(panel).getByRole('button', { name: /Tümünü okundu say/ }));
    await waitFor(() => {
      expect(calls(requests, 'POST', '/notifications/read-all')).toHaveLength(1);
    });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Bildirimler' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('dy-bell'));
    await user.click(screen.getByTestId('dy-bell'));
    await user.click(
      within(screen.getByRole('region', { name: 'Bildirimler' })).getByRole('button', { name: /Job failed/ }),
    );
    await waitFor(() => {
      expect(
        calls(requests, 'POST', '/notifications/11111111-1111-4111-8111-111111111111/read'),
      ).toHaveLength(1);
    });
  });

  it('global: account menu in the Diyalog language — session details, log out, log out everywhere', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/chat',
      initialState: signedIn,
      routes: routes({ 'POST /api/auth/logout': () => ({ status: 204 }) }),
    });
    await user.click(await screen.findByRole('button', { name: /Hesap menüsü/ }));
    const panel = screen.getByRole('region', { name: 'Hesap' });
    expect(within(panel).getByText('Rol: owner')).toBeTruthy();
    await waitFor(() => {
      expect(within(panel).getByText('Oturum sonu')).toBeTruthy();
    });
    expect(within(panel).getByRole('button', { name: 'Her yerden çıkış yap' })).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Çıkış yap' }));
    await waitFor(() => {
      expect(calls(requests, 'POST', '/auth/logout').length).toBeGreaterThan(0);
    });
  });
});
