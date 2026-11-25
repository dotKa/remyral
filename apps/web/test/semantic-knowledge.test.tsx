// p10-semantic-defaults-chat (docs/design/p10-semantic-memory.md §12): the create-project knowledge toggles, "search my
// conversations" by meaning, the conversation header ("Shared with project X knowledge" and its switch), the "used N
// related items" disclosure under an answer, and the personal settings in Settings → Chat (opt-out).
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

const T1 = '00000000-0000-4000-8000-0000000000d1';
const T2 = '00000000-0000-4000-8000-0000000000d2';
const NOW = '2026-10-18T10:00:00.000Z';

configure({ asyncUtilTimeout: 5_000 });

const signedIn = (role = 'owner'): AuthState => ({
  kind: 'signedIn',
  user: { ...USER, role },
  session: null,
  remainingRecoveryCodes: null,
});

class FakeEventSource {
  static readonly CLOSED = 2;
  readonly listeners = new Map<string, ((m: MessageEvent<string>) => void)[]>();
  readyState = 1;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (m: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close(): void {
    this.readyState = 2;
  }
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  stubCookies('__Host-ras-csrf=csrf-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Routes with prefix fallbacks for query-string URLs (search, filtered lists). */
const AVAILABLE = {
  enabled: true,
  available: true,
  code: null,
  message: null,
  worker: { id: 'w1', name: 'mac-1', online: true },
  runtime: 'claude-code',
  model: null,
  limits: { turnsPerUserPer10Min: 30, userDailyTokens: 2000000 },
};

function chatBase(): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/chat/status': () => ({ status: 200, body: AVAILABLE }),
    'GET /api/notifications?limit=20': () => ({
      status: 200,
      body: { items: [], unreadCount: 0, nextCursor: null },
    }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/chat/threads': () => ({
      status: 200,
      body: {
        items: [
          { id: T1, title: 'Rollback', archived: false, createdAt: NOW, updatedAt: NOW, unreadCount: 0 },
          { id: T2, title: 'Salary', archived: false, createdAt: NOW, updatedAt: NOW, unreadCount: 0 },
        ],
      },
    }),
    [`POST /api/chat/threads/${T1}/read`]: () => ({
      status: 200,
      body: { threadId: T1, lastReadSeq: 2, lastReadAt: NOW, unreadCount: 0 },
    }),
  };
}

const knowledge = (over: Record<string, unknown> = {}) => ({
  project: 'kp',
  share: true,
  personalShare: true,
  sharedWith: ['kp'],
  notShared: [],
  suggestedProject: null,
  ...over,
});

function detail(k: Record<string, unknown>): Handler {
  return () => ({
    status: 200,
    body: {
      thread: { id: T1, title: 'Rollback', archived: false, createdAt: NOW, updatedAt: NOW },
      messages: [
        {
          id: 'm1',
          seq: 1,
          role: 'user',
          content: 'How do we roll back?',
          meta: {
            related: {
              mode: 'semantic',
              items: [
                {
                  kind: 'context_doc',
                  id: 'd1',
                  project: 'kp',
                  title: 'Rollback runbook',
                  at: NOW,
                  link: '/settings/context?namespace=project%3Akp',
                  score: 0.8,
                },
                {
                  kind: 'project_chat',
                  id: 'c1',
                  project: 'kp',
                  title: 'Conversation of bob',
                  at: NOW,
                  link: null,
                  score: 0.6,
                },
                // A link that is not console-relative is dropped (rendered as text).
                {
                  kind: 'own_chat',
                  id: 'o1',
                  project: null,
                  title: 'Earlier talk',
                  at: NOW,
                  link: 'https://x',
                },
              ],
            },
          },
          turnId: null,
          createdAt: NOW,
        },
        {
          id: 'm2',
          seq: 2,
          role: 'assistant',
          content: 'Use kubectl rollout undo [1].',
          meta: null,
          turnId: 't1',
          createdAt: NOW,
        },
      ],
      drafts: [],
      turn: null,
      watches: [],
      knowledge: k,
    },
  });
}

describe('chat: knowledge in the conversation', { timeout: 30_000 }, () => {
  it('an unlinked conversation offers the suggested project', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn('operator'),
      routes: {
        ...chatBase(),
        [`GET /api/chat/threads/${T1}`]: detail(
          knowledge({ project: null, sharedWith: [], suggestedProject: 'kp' }),
        ),
        [`PUT /api/chat/threads/${T1}/knowledge`]: () => ({ status: 200, body: knowledge() }),
      },
    });
    await user.click(await screen.findByTestId('knowledge-suggested'));
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({ project: 'kp' });
    });
  });

  it('without assisted mode there is no summarise action', async () => {
    renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn('operator'),
      routes: { ...chatBase(), [`GET /api/chat/threads/${T1}`]: detail(knowledge()) },
    });
    await screen.findByTestId('knowledge-shared');
    expect(screen.queryByTestId('knowledge-summarise')).toBeNull();
  });
});
