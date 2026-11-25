// p14-i18n-screens-a (i18n Phase 5): Sohbet (`diyalog/chat/*`) comes from the `chat` catalog — Turkish by default
// (diyalog-chat-w4 and the other chat suites keep querying the Turkish text), English when the user's language is
// `en`: the conversation list, a row's menu, the organize dialogs, the empty state's suggestions.
import { configure, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { messagesFor } from '@remyral/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { suggestions } from '../src/diyalog/chat/DiyalogChat';
import { LOCALE_STORAGE_KEY } from '../src/i18n/I18nProvider';
import { type Handler, renderApp, sessionBody, stubCookies } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const T1 = '00000000-0000-4000-8000-0000000000d1';
const G1 = '00000000-0000-4000-8000-0000000000e1';
const NOW = new Date().toISOString();

const thread = {
  id: T1,
  title: 'Plain chat',
  archived: false,
  createdAt: NOW,
  updatedAt: NOW,
  unreadCount: 0,
  pinnedAt: null,
  groupId: null,
  tagIds: [],
};

const ORGANIZE = {
  groups: [{ id: G1, name: 'Deploys', position: 0, collapsed: false, threadCount: 0 }],
  tags: [],
  pinned: 0,
};

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

const routes: Record<string, Handler> = {
  'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
  'GET /api/chat/status': ok(STATUS),
  'GET /api/notifications?limit=20': ok({ items: [], unreadCount: 0, nextCursor: null }),
  'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
  'GET /api/chat/threads': ok({ items: [thread], organize: ORGANIZE, nextCursor: null }),
  'GET /api/chat/threads?limit=1': ok({ items: [thread], nextCursor: null }),
  'GET /api/workers': ok({ workers: [] }),
  'GET /api/fleet/overview': ok({ workers: [] }),
};

function open(locale: 'tr' | 'en') {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  return renderApp({ path: '/chat?yeni=1', initialState: signedIn, routes, i18n: true });
}

beforeEach(() => {
  window.localStorage.clear();
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
  Element.prototype.scrollIntoView = vi.fn();
});

describe('Sohbet in English', { timeout: 30_000 }, () => {
  it('names the conversation list, a row menu and the move dialog in English', async () => {
    const user = userEvent.setup();
    open('en');
    const nav = await screen.findByRole('navigation', { name: 'Conversation list' });
    await within(nav).findByText('Plain chat');
    await user.click(within(nav).getByRole('button', { name: 'Actions for Plain chat' }));
    const menu = screen.getByRole('menu', { name: 'Actions for Plain chat' });
    expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toBeTruthy();
    await user.click(within(menu).getByRole('menuitem', { name: 'Move to group…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move to group' });
    expect(within(dialog).getByRole('radio', { name: 'No group' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Create and move' })).toBeTruthy();
    for (const tr of ['Sohbet listesi', 'Gruba taşı', 'Grup yok']) expect(screen.queryByText(tr)).toBeNull();
  });

  it('keeps the Turkish copy for Turkish users', async () => {
    open('tr');
    const nav = await screen.findByRole('navigation', { name: 'Sohbet listesi' });
    expect(await within(nav).findByRole('button', { name: 'Plain chat için eylemler' })).toBeTruthy();
  });

  it('the empty state suggests in the user language', () => {
    const en = suggestions(messagesFor('en'));
    expect(en).toContain('Which machines are idle?');
    expect(en).not.toEqual(suggestions(messagesFor('tr')));
  });
});
