import { configure, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDraft } from '../src/api/chat';
import { Markdown, parseBlocks } from '../src/screens/chat/markdown';
import { buildRows } from '../src/screens/chat/rows';
import { groupThreads, threadGroup } from '../src/screens/chat/time';
import { draftFromPrefill } from '../src/screens/composer/prefill';
import { type Handler, renderApp, sessionBody, stubCookies } from './helpers';

/** p5-chat-ux: full-height layout, scrolling, messages, drafts, thread list, drawer, status line. */

const T1 = '00000000-0000-4000-8000-0000000000c1';
const D1 = '00000000-0000-4000-8000-0000000000d1';
const NOW = new Date().toISOString();

function thread(id: string, title: string, updatedAt = NOW): Record<string, unknown> {
  return { id, title, archived: false, createdAt: updatedAt, updatedAt };
}

function msg(seq: number, role: string, content: string, meta: Record<string, unknown> | null = null) {
  return { id: `m${String(seq)}`, seq, role, content, meta, turnId: null, createdAt: NOW };
}

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

class FakeEventSource {
  static readonly CLOSED = 2;
  static last: FakeEventSource | null = null;
  readonly listeners = new Map<string, ((m: MessageEvent<string>) => void)[]>();
  readyState = 1;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (m: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? [])
      fn({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
  close(): void {
    this.readyState = 2;
  }
}

// Full-page renders are slow on a loaded host; allow more than the 1 s default for findBy*.
configure({ asyncUtilTimeout: 5_000 });

beforeEach(() => {
  FakeEventSource.last = null;
  vi.stubGlobal('EventSource', FakeEventSource);
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function base(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/chat/status': () => ({ status: 200, body: AVAILABLE }),
    'GET /api/notifications?limit=20': () => ({
      status: 200,
      body: { items: [], unreadCount: 0, nextCursor: null },
    }),
    'GET /api/chat/threads': () => ({ status: 200, body: { items: [thread(T1, 'Fleet')] } }),
    ...extra,
  };
}

/** Gives the (layout-less) jsdom scroll container real-looking dimensions. */
describe('Chat layout (p5-chat-ux)', { timeout: 30_000 }, () => {
  it('other pages keep the normal growing page', async () => {
    const { container } = renderApp({
      path: '/settings/chat',
      routes: base({
        'GET /api/chat/settings': () => ({ status: 404, body: { error: 'x', message: 'x' } }),
        'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
        'GET /api/models': () => ({ status: 200, body: { items: [], defaults: [] } }),
      }),
    });
    await waitFor(() => {
      expect(container.querySelector('[data-shell]')?.getAttribute('data-shell')).toBe('page');
    });
  });
});

describe('Messages (p5-chat-ux)', { timeout: 30_000 }, () => {
  it('groups tool rows and attaches drafts where they were proposed', () => {
    const rows = buildRows(
      [
        msg(1, 'user', 'q') as never,
        msg(2, 'tool', 'a: ok') as never,
        msg(3, 'tool', 'draft_job: card', { draftId: D1 }) as never,
        msg(4, 'assistant', 'done') as never,
      ],
      [{ id: D1, createdAt: NOW } as ChatDraft, { id: 'other', createdAt: NOW } as ChatDraft],
    );
    expect(rows.rows.map((r) => r.kind)).toEqual(['message', 'tools', 'message']);
    expect(rows.rows[1]?.drafts.map((d) => d.id)).toEqual([D1]);
    // p9-chat-card-order: a draft without a loaded anchor is placed by creation time, never appended last.
    expect(rows.leading.map((d) => d.id)).toEqual([]);
    expect(rows.rows[2]?.drafts.map((d) => d.id)).toEqual(['other']);
  });
});

describe('Markdown safety (p5-chat-ux)', () => {
  it('renders tables, quotes, rules and code with a language, never HTML', () => {
    const text = [
      '| Worker | State |',
      '| :--- | ---: |',
      '| <img src=x onerror=alert(1)> | **idle** |',
      '| [x](javascript:alert(1)) | a \\| b |',
      '',
      '> <script>alert(1)</script> quoted',
      '',
      '---',
      '```html"><script>alert(2)</script>',
      '<iframe src="https://evil.example"></iframe>',
      '```',
    ].join('\n');
    const { container } = render(<Markdown text={text} />);
    for (const tag of ['img', 'script', 'iframe']) expect(container.querySelector(tag)).toBeNull();
    const table = container.querySelector('table');
    expect(table?.querySelectorAll('th')).toHaveLength(2);
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(table?.querySelector('th:last-child')?.className).toContain('text-right');
    expect(table?.querySelector('tbody td')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(table?.querySelector('strong')?.textContent).toBe('idle');
    expect(table?.querySelector('a')).toBeNull();
    expect(table?.querySelectorAll('tbody tr')[1]?.lastElementChild?.textContent).toBe('a | b');
    expect(container.querySelector('blockquote')?.textContent).toContain('<script>');
    expect(container.querySelector('hr')).not.toBeNull();
    expect(container.querySelector('pre code')?.textContent).toBe(
      '<iframe src="https://evil.example"></iframe>',
    );
    // The fence's "language" is not a valid name: it is not used as one.
    expect(parseBlocks('```html"><x>\nhi\n```')[0]).toMatchObject({ kind: 'code', lang: 'html' });
  });
});

describe('Draft cards (p5-chat-ux)', () => {
  it('drops malformed prefill values', () => {
    expect(
      draftFromPrefill({
        project: 'bad project!',
        spec: {
          runtime: 'rm -rf',
          sandboxProfile: 'root',
          approvalPolicy: 'yolo',
          prompt: 7,
          limits: { maxCostUsd: -1 },
        },
      }),
    ).toEqual({ mode: 'job' });
  });
});

describe('Thread list (p5-chat-ux)', { timeout: 30_000 }, () => {
  it('groups by Today / Yesterday / Last 7 days / Older', () => {
    const now = new Date(2026, 9, 14, 12, 0);
    const at = (d: number, h = 10) => new Date(2026, 9, d, h, 0).toISOString();
    expect(threadGroup(at(14, 0), now)).toBe('Today');
    expect(threadGroup(at(13, 23), now)).toBe('Yesterday');
    expect(threadGroup(at(8), now)).toBe('Last 7 days');
    expect(threadGroup(at(7), now)).toBe('Older');
    const groups = groupThreads(
      [
        { id: 'a', updatedAt: at(14) },
        { id: 'b', updatedAt: at(13) },
        { id: 'c', updatedAt: at(1) },
        { id: 'd', updatedAt: at(14, 8) },
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['Today', ['a', 'd']],
      ['Yesterday', ['b']],
      ['Older', ['c']],
    ]);
  });
});
