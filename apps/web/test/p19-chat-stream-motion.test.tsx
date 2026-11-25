// p19-chat-stream-motion: the answer being written shows at a steady pace (the stream's bursts drain frame by frame,
// a caret at the writing end), and when the turn ends its text stays until the finished answer replaces it — no typing
// dots in between.
import { act, configure, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messagesFor } from '@remyral/i18n';
import type { AuthState } from '../src/auth/AuthProvider';
import { Typing } from '../src/diyalog/chat/rows';
import { cutAt, DONE_S, DRAIN_S, MIN_CPS, nextReveal } from '../src/diyalog/chat/smoothText';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { type Handler, renderApp, sessionBody, stubCookies } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const TR = messagesFor('tr');

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const T1 = '00000000-0000-4000-8000-0000000000d1';
const M1 = '00000000-0000-4000-8000-0000000000a1';
const M2 = '00000000-0000-4000-8000-0000000000a2';
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

const state: { turn: Record<string, unknown> | null; answer: string | null } = { turn: null, answer: null };

function routes(): Record<string, Handler> {
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
    [`GET /api/chat/threads/${T1}`]: () => ({
      status: 200,
      body: {
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
          ...(state.answer === null
            ? []
            : [
                {
                  id: M2,
                  seq: 2,
                  role: 'assistant',
                  content: state.answer,
                  meta: null,
                  turnId: 'turn-1',
                  createdAt: NOW,
                },
              ]),
        ],
        drafts: [],
        turn: state.turn,
        watches: [],
        starred: [],
      },
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

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
  window.localStorage.clear();
  DrivenEventSource.all = [];
  vi.stubGlobal('EventSource', DrivenEventSource);
  state.turn = null;
  state.answer = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the reveal pace (p19-chat-stream-motion)', () => {
  it('keeps a floor speed, drains a backlog within its window and faster once the turn ended', () => {
    expect(nextReveal(0, 10, 0.016, false)).toBeCloseTo(MIN_CPS * 0.016);
    // 1000 characters waiting: the whole backlog in DRAIN_S (a frame shows its share).
    expect(nextReveal(0, 1000, 0.016, false)).toBeCloseTo((1000 / DRAIN_S) * 0.016);
    expect(nextReveal(0, 1000, 0.016, true)).toBeCloseTo((1000 / DONE_S) * 0.016);
    expect(nextReveal(990, 1000, 1, false)).toBe(1000);
    expect(nextReveal(1000, 1000, 1, false)).toBe(1000);
    // At least one character a frame, even for a tiny dt.
    expect(nextReveal(0, 10, 0, false)).toBe(1);
  });

  it('cuts at the end of the word it falls in, when that is near', () => {
    expect(cutAt('Kuyrukta üç iş var', 3)).toBe('Kuyrukta');
    expect(cutAt('Kuyrukta üç iş var', 8)).toBe('Kuyrukta');
    expect(cutAt('Kuyrukta üç iş var', 9)).toBe('Kuyrukta üç');
    expect(cutAt('Kuyrukta', 3)).toBe('Kuy');
    expect(cutAt('abc', 10)).toBe('abc');
  });
});

describe('Typing reveals the stream (p19-chat-stream-motion)', () => {
  it('a burst shows over several frames and ends in a caret line', async () => {
    const long = 'Kuyrukta üç iş var; ikisi onay bekliyor, biri bir makineye atanmış ve çalışıyor. '.repeat(
      4,
    );
    const r = render(
      <I18nProvider>
        <Typing text="" />
      </I18nProvider>,
    );
    r.rerender(
      <I18nProvider>
        <Typing text={long} />
      </I18nProvider>,
    );
    const body = await screen.findByTestId('markdown');
    const first = body.textContent.length;
    expect(first).toBeLessThan(long.trim().length);
    expect(body.closest('[data-role="assistant"]')?.className).toContain('dy-m-streaming');
    await waitFor(() => {
      expect(screen.getByTestId('markdown').textContent).toBe(long.trim());
    });
  });

  it('an answer already being written when the view opens stands still', () => {
    render(
      <I18nProvider>
        <Typing text="Zaten yazıyor" />
      </I18nProvider>,
    );
    expect(screen.getByTestId('markdown').textContent).toBe('Zaten yazıyor');
  });
});

describe('the end of a turn (p19-chat-stream-motion)', { timeout: 30_000 }, () => {
  it('the written text stays until the finished answer replaces it — no typing dots in between', async () => {
    state.turn = { id: 'turn-1', state: 'running', text: '' };
    renderApp({ path: `/chat/${T1}`, initialState: signedIn, routes: routes() });
    await waitFor(() => {
      expect(DrivenEventSource.all.length).toBeGreaterThan(0);
    });
    act(() => {
      stream().emit('turn', { id: 'turn-1', state: 'running' });
      stream().emit('delta', { turnId: 'turn-1', text: 'Kuyrukta üç iş' });
    });
    expect(await screen.findByText('Kuyrukta üç iş')).toBeTruthy();

    // The master closes the turn, stores the answer, then says message + done.
    state.turn = null;
    state.answer = 'Kuyrukta üç iş var.';
    act(() => {
      stream().emit('message', { id: M2 });
      stream().emit('done', { turnId: 'turn-1' });
    });
    // Right after `done`: the text is still there and no typing dots took its place.
    expect(screen.getByText('Kuyrukta üç iş')).toBeTruthy();
    expect(screen.queryByText(TR.shared.chat.typing)).toBeNull();
    expect(await screen.findByText('Kuyrukta üç iş var.')).toBeTruthy();
    expect(screen.queryByText('Kuyrukta üç iş')).toBeNull();
    expect(screen.queryByText(TR.shared.chat.typing)).toBeNull();
  });
});
