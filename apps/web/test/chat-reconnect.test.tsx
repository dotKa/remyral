// p17-chat-reconnect (docs/design/p17-chat-reconnect.md): while the answering machine reconnects the chat shows a
// quiet "Bağlantı yeniden kuruluyor…" under the answer being written — no error banner — and clears it when the turn
// continues.
import { act, configure, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messagesFor } from '@remyral/i18n';
import type { AuthState } from '../src/auth/AuthProvider';
import { type Handler, renderApp, sessionBody, stubCookies } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const TR = messagesFor('tr');
const RECONNECTING = TR.shared.chat.reconnecting;

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const T1 = '00000000-0000-4000-8000-0000000000d1';
const M1 = '00000000-0000-4000-8000-0000000000a1';
const NOW = new Date().toISOString();

const THREAD = {
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

function routes(turn: Record<string, unknown> | null): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/chat/status': ok(STATUS),
    'GET /api/notifications?limit=20': ok({ items: [], unreadCount: 0, nextCursor: null }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/chat/threads': ok({
      items: [THREAD],
      organize: { groups: [], tags: [], pinned: 0 },
      nextCursor: null,
    }),
    'GET /api/chat/threads?limit=1': ok({ items: [THREAD], nextCursor: null }),
    [`GET /api/chat/threads/${T1}`]: ok({
      thread: THREAD,
      messages: [
        {
          id: M1,
          seq: 1,
          role: 'user',
          content: 'Kuyruk ne durumda?',
          meta: null,
          turnId: null,
          createdAt: NOW,
        },
      ],
      drafts: [],
      turn,
      watches: [],
      starred: [],
    }),
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
  };
}

/** A stream the test drives: `emit(name, data)` dispatches one server-sent event. */
class DrivenEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static all: DrivenEventSource[] = [];
  readyState = 1;
  onerror: (() => void) | null = null;
  readonly #listeners = new Map<string, ((m: MessageEvent<string>) => void)[]>();
  constructor(readonly url: string) {
    DrivenEventSource.all.push(this);
  }
  addEventListener(name: string, fn: (m: MessageEvent<string>) => void): void {
    this.#listeners.set(name, [...(this.#listeners.get(name) ?? []), fn]);
  }
  close(): void {
    this.readyState = 2;
  }
  emit(name: string, data: unknown): void {
    for (const fn of this.#listeners.get(name) ?? [])
      fn(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
}

const stream = (): DrivenEventSource => {
  const s = DrivenEventSource.all.at(-1);
  if (s === undefined) throw new Error('no stream');
  return s;
};

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
  window.localStorage.clear();
  DrivenEventSource.all = [];
  vi.stubGlobal('EventSource', DrivenEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('chat reconnecting state (p17-chat-reconnect)', { timeout: 30_000 }, () => {
  it('shows the quiet reconnecting line while the turn waits and clears it when the turn continues', async () => {
    renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: routes({ id: 'turn-1', state: 'running', text: '' }),
    });
    await waitFor(() => {
      expect(DrivenEventSource.all.length).toBeGreaterThan(0);
    });
    act(() => {
      stream().emit('turn', { id: 'turn-1', state: 'running' });
      stream().emit('delta', { turnId: 'turn-1', text: 'Kuyrukta üç iş' });
    });
    expect(await screen.findByText('Kuyrukta üç iş')).toBeTruthy();
    expect(screen.queryByTestId('dy-reconnecting')).toBeNull();

    act(() => {
      stream().emit('turn', { id: 'turn-1', state: 'reconnecting' });
    });
    const line = await screen.findByTestId('dy-reconnecting');
    expect(line.textContent).toBe(RECONNECTING);
    expect(line.textContent).toBe('Bağlantı yeniden kuruluyor…');
    // The text written so far stays; no error banner.
    expect(screen.getByText('Kuyrukta üç iş')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => {
      stream().emit('turn', { id: 'turn-1', state: 'running' });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('dy-reconnecting')).toBeNull();
    });
    act(() => {
      stream().emit('delta', { turnId: 'turn-1', text: ', ikisi bekliyor.' });
    });
    expect(await screen.findByText('Kuyrukta üç iş, ikisi bekliyor.')).toBeTruthy();
  });

  it('a conversation opened while its turn waits shows the state from the stream snapshot', async () => {
    renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: routes({ id: 'turn-1', state: 'reconnecting', text: '' }),
    });
    await waitFor(() => {
      expect(DrivenEventSource.all.length).toBeGreaterThan(0);
    });
    // Before the stream says anything, the thread detail's turn state counts.
    expect((await screen.findByTestId('dy-reconnecting')).textContent).toBe(RECONNECTING);
    act(() => {
      stream().emit('ready', { turn: { id: 'turn-1', state: 'reconnecting', text: '' } });
    });
    expect(screen.getByTestId('dy-reconnecting')).toBeTruthy();
    act(() => {
      stream().emit('delta', { turnId: 'turn-1', text: 'Devam ediyorum' });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('dy-reconnecting')).toBeNull();
    });
  });
});
