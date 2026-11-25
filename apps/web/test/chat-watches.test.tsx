import { configure, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shortWatchLabel, WATCH_LABEL_MAX } from '../src/diyalog/chat/ContextStrip';
import { renderApp, sessionBody, stubCookies } from './helpers';

/** p6-chat-notify: the conversation's watch strip (what the assistant will tell the user about) and Stop. */

const T1 = '00000000-0000-4000-8000-0000000000c1';
const W1 = '00000000-0000-4000-8000-0000000000e1';
const W2 = '00000000-0000-4000-8000-0000000000e2';
const JOB = '00000000-0000-4000-8000-0000000000a1';
const NOW = new Date().toISOString();
const LATER = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();

configure({ asyncUtilTimeout: 5_000 });

class SilentEventSource {
  static readonly CLOSED = 2;
  readyState = 1;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {
    this.readyState = 2;
  }
}

function watch(id: string, label: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    threadId: T1,
    target: { kind: 'job', id: JOB },
    label,
    project: 'alpha',
    conditions: ['finished'],
    repeat: 'once',
    language: 'tr',
    state: 'active',
    endReason: null,
    fireCount: 0,
    check: null,
    lastFiredAt: null,
    createdAt: NOW,
    expiresAt: LATER,
    endedAt: null,
    link: `/jobs/${JOB}`,
    ...extra,
  };
}

beforeEach(() => {
  vi.stubGlobal('EventSource', SilentEventSource);
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Chat watches (p6-chat-notify)', { timeout: 30_000 }, () => {
  it('folds more than two watches into one line that opens the list', async () => {
    // Diyalog (the default console) folds the strip; the classic list stays as it was.
    const ids = [W1, W2, '00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-0000000000a4'];
    renderApp({
      path: `/chat/${T1}`,
      routes: {
        'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
        'GET /api/chat/status': () => ({ status: 404, body: { error: 'x', message: 'x' } }),
        'GET /api/notifications?limit=20': () => ({
          status: 200,
          body: { items: [], unreadCount: 0, nextCursor: null },
        }),
        'GET /api/chat/threads': () => ({ status: 200, body: { items: [] } }),
        [`GET /api/chat/threads/${T1}`]: () => ({
          status: 200,
          body: {
            thread: { id: T1, title: 'Deploy', archived: false, createdAt: NOW, updatedAt: NOW },
            messages: [],
            drafts: [],
            turn: null,
            watches: ids.map((id, i) => watch(id, `Job ${String(i)}: deploy`)),
          },
        }),
      },
    });
    const strip = await screen.findByTestId('chat-watches');
    const toggle = within(strip).getByTestId('chat-watches-toggle');
    expect(toggle.textContent).toContain('4 izleme');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(strip).queryByRole('list')).toBeNull();
    await userEvent.click(toggle);
    expect(within(strip).getAllByRole('listitem')).toHaveLength(4);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('p15-merge-approvals: watch labels in the strip', () => {
  it('cuts a long label at a word (the full label stays in the tooltip)', () => {
    const long =
      'Job 0a1b2c3d: Bu işin dalı, SampleWebApp uygulamasının Coolify DEPLOY DALI olacak. Uygulamayı yeniden kur';
    const s = shortWatchLabel(long);
    expect(s.length).toBeLessThanOrEqual(WATCH_LABEL_MAX);
    expect(s.endsWith('…')).toBe(true);
    expect(s.startsWith('Job 0a1b2c3d: Bu işin dalı')).toBe(true);
    expect(shortWatchLabel('İş 0a1b2c3d · Coolify dalı')).toBe('İş 0a1b2c3d · Coolify dalı');
  });
});
