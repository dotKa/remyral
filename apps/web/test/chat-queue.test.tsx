// p22-chat-queue (docs/design/p22-chat-queue.md): while Remyral answers, the composer's send button stays enabled and
// says the message is queued; Enter sends it with `queue: true`, the field clears, and the master's queued message shows
// as a "Sırada" bubble with Düzenle / Kaldır and "Şimdi gönder" (which stops the answer).
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messagesFor } from '@remyral/i18n';
import type { AuthState } from '../src/auth/AuthProvider';
import { type Handler, renderApp, sessionBody, stubCookies } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const TR = messagesFor('tr');

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const T1 = '00000000-0000-4000-8000-0000000000e1';
const Q1 = '00000000-0000-4000-8000-0000000000f1';
const NOW = new Date().toISOString();

const THREAD = {
  id: T1,
  title: 'Sohbet',
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

let queued: Record<string, unknown>[] = [];
let posted: unknown[] = [];
let deleted: string[] = [];
let cancelled = 0;

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
            id: '10000000-0000-4000-8000-000000000001',
            seq: 1,
            role: 'user',
            content: 'İlk soru',
            meta: null,
            turnId: null,
            createdAt: NOW,
          },
        ],
        drafts: [],
        // The assistant is answering.
        turn: { id: 'turn-1', state: 'running', text: 'Yazıyor' },
        watches: [],
        starred: [],
        queued: [...queued],
      },
    }),
    [`POST /api/chat/threads/${T1}/read`]: ok({
      threadId: T1,
      lastReadSeq: 99,
      lastReadAt: NOW,
      unreadCount: 0,
    }),
    [`GET /api/chat/threads/${T1}/assets?kind=starred&scope=thread&limit=30`]: ok({
      items: [],
      nextCursor: null,
    }),
    [`POST /api/chat/threads/${T1}/messages`]: (req) => {
      posted.push(req.body);
      const q = {
        id: Q1,
        content: (req.body as { text: string }).text,
        meta: { origin: 'user' },
        attachments: 0,
        holdReason: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      queued.push(q);
      return { status: 202, body: { queued: q, dropped: [] } };
    },
    [`DELETE /api/chat/threads/${T1}/queued/${Q1}`]: () => {
      deleted.push(Q1);
      queued = [];
      return { status: 204 };
    },
    [`POST /api/chat/threads/${T1}/cancel`]: () => {
      cancelled += 1;
      return { status: 202, body: { ok: true } };
    },
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/fleet/overview': ok({ workers: [] }),
  };
}

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
  window.localStorage.clear();
  queued = [];
  posted = [];
  deleted = [];
  cancelled = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Sohbet message queue (p22-chat-queue)', { timeout: 30_000 }, () => {
  it('keeps the send button enabled while Remyral answers and queues the message', async () => {
    const user = userEvent.setup();
    renderApp({ path: `/chat/${T1}`, initialState: signedIn, routes: routes() });
    await screen.findByText('İlk soru');
    const field = screen.getByTestId<HTMLTextAreaElement>('dy-composer-field');
    expect(field.disabled).toBe(false);
    await user.type(field, 'Bir de şunu ekle');
    const button = screen.getByRole('button', { name: TR.home.composer.queue });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute('title')).toBe(TR.home.composer.queueHint);
    // The stop button stays as before.
    expect(screen.getByRole('button', { name: TR.home.composer.stop })).toBeTruthy();

    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    expect(posted[0]).toMatchObject({ text: 'Bir de şunu ekle', queue: true });
    await waitFor(() => {
      expect(field.value).toBe('');
    });

    const bubble = await screen.findByTestId('chat-queued-item');
    expect(within(bubble).getByText('Bir de şunu ekle')).toBeTruthy();
    expect(within(bubble).getByTestId('chat-queued-badge').textContent).toBe(TR.chatQueue.badge);
    // Not a thread message: it waits under the answer.
    expect(within(screen.getByRole('log')).queryByText('Bir de şunu ekle')).toBeNull();

    // "Şimdi gönder" stops the running answer (the master then sends what waited).
    fireEvent.click(screen.getByTestId('chat-queued-send-now'));
    await waitFor(() => {
      expect(cancelled).toBe(1);
    });

    await user.click(within(bubble).getByRole('button', { name: TR.chatQueue.removeLabel }));
    await waitFor(() => {
      expect(deleted).toEqual([Q1]);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('chat-queued-item')).toBeNull();
    });
  });
});
