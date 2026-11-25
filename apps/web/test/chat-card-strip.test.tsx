// p15-chat-cards-scroll items 1–2 (docs/design/p15-chat-cards-scroll.md): a turn's cards are not shown above or
// between its streamed text — they follow the finished answer as one compact strip of collapsed cards (a scrollable
// row with ‹ ›, "1/3" and keyboard navigation when there are several; one open at a time, inline below the row).
import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ThreadDetail } from '../src/api/chat';
import type { AuthState } from '../src/auth/AuthProvider';
import { chatItems } from '../src/diyalog/ops/timeline';
import { invalidate } from '../src/lib/invalidate';
import { type Handler, renderApp, sessionBody } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const NOW = Date.now();
const MIN = 60_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const THREAD = '6b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f';
const JOB = '11111111-1111-4111-8111-111111111111';
const thread = { id: THREAD, title: 'Ops', archived: false, createdAt: iso(90 * MIN), updatedAt: iso(MIN) };
const empty = { status: 200, body: { items: [], nextCursor: null } };

let n = 0;
function draft(title: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    threadId: THREAD,
    kind: 'worker_config',
    title,
    payload: { workerId: 'w1', patch: { maxParallel: 2 }, reason: 'yük' },
    project: 'acme',
    state: 'proposed',
    result: null,
    createdAt: iso(3 * MIN),
    expiresAt: iso(-28 * MIN),
    decidedAt: null,
    ...over,
  };
}

function msg(id: string, seq: number, role: string, content: string, meta: unknown = null, ago = 4 * MIN) {
  return {
    id,
    seq,
    role,
    content,
    meta,
    turnId: role === 'user' ? null : 'turn-1',
    createdAt: iso(ago - seq * 1000),
  };
}

interface State {
  messages: unknown[];
  drafts: unknown[];
  turn: unknown;
}

function routes(state: State): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/chat/status': () => ({
      status: 200,
      body: {
        enabled: true,
        available: true,
        code: null,
        message: null,
        worker: { id: 'w1', name: 'mac-1', online: true },
        runtime: 'claude-code',
        model: null,
        limits: { turnsPerUserPer10Min: 30, userDailyTokens: null },
        input: null,
      },
    }),
    'GET /api/chat/threads': () => ({ status: 200, body: { items: [thread], nextCursor: null } }),
    'GET /api/chat/threads?limit=1': () => ({ status: 200, body: { items: [thread], nextCursor: null } }),
    [`GET /api/chat/threads/${THREAD}`]: () => ({
      status: 200,
      body: {
        thread,
        messages: state.messages,
        drafts: state.drafts,
        turn: state.turn,
        watches: [],
        starred: [],
      },
    }),
    [`POST /api/chat/threads/${THREAD}/read`]: () => ({
      status: 200,
      body: { threadId: THREAD, lastReadSeq: 99, lastReadAt: iso(0), unreadCount: 0 },
    }),
    'GET /api/approvals?status=pending': () => ({ status: 200, body: { items: [] } }),
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/projects': () => ({ status: 200, body: { items: [] } }),
    'GET /api/notifications?limit=20': () => empty,
  };
}

function open(state: State) {
  return renderApp({ path: `/chat/${THREAD}`, initialState: signedIn, routes: routes(state) });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('chatItems: a turn’s cards after its last row', () => {
  const base = (over: Record<string, unknown>): ThreadDetail => ({
    thread,
    messages: [],
    drafts: [],
    turn: null,
    watches: [],
    knowledge: null,
    starred: [],
    ...over,
  });

  it('moves the drafts of a turn’s tool lines below its answer; one strip per turn; pending while the turn runs', () => {
    const d1 = draft('Birinci');
    const d2 = draft('İkinci');
    const d3 = draft('Üçüncü');
    const messages = [
      msg('m1', 1, 'user', 'iki şey yap'),
      msg('m2', 2, 'tool', 'draft', { name: 'propose_worker_config', draftId: d1.id }),
      msg('m3', 3, 'tool', 'draft', { name: 'propose_worker_config', draftId: d2.id }),
      msg('m4', 4, 'assistant', 'İki kart hazırladım.'),
      msg('m5', 5, 'user', 'bir tane daha'),
      msg('m6', 6, 'tool', 'draft', { name: 'propose_worker_config', draftId: d3.id }),
    ];
    const done = chatItems(base({ messages, drafts: [d1, d2, d3] }));
    expect(done.map((i) => i.key)).toEqual([
      'm:m1',
      't:m2',
      'm:m4',
      'cards:m:m1',
      'm:m5',
      't:m6',
      'cards:m:m5',
    ]);
    const first = done[3];
    expect(first?.kind === 'cards' ? first.cards.map((c) => c.key) : null).toEqual([
      `draft:${String(d1.id)}`,
      `draft:${String(d2.id)}`,
    ]);
    expect(done.at(-1)).toMatchObject({ kind: 'cards', pending: false });
    // The conversation's turn is still open: the last strip is pending (held back by the screen).
    const running = chatItems(
      base({
        messages,
        drafts: [d1, d2, d3],
        turn: { id: 'k', state: 'running', text: '' },
      }),
    );
    expect(running.at(-1)).toMatchObject({ kind: 'cards', key: 'cards:m:m5', pending: true });
    expect(running[3]).toMatchObject({ kind: 'cards', pending: false });
  });
});

describe('Sohbet: cards under the finished answer', { timeout: 30_000 }, () => {
  it('while the answer is written only "1 kart hazırlanıyor"; once the turn ends the strip follows the answer', async () => {
    const d1 = draft('atlas paralelliği');
    const state: State = {
      messages: [
        msg('m1', 1, 'user', 'atlas paralelliğini artır'),
        msg('m2', 2, 'tool', 'draft', { name: 'propose_worker_config', draftId: d1.id }),
      ],
      drafts: [d1],
      turn: { id: 'k', state: 'running', text: '' },
    };
    open(state);
    const log = await screen.findByRole('log', { name: 'Sohbet' });
    expect((await within(log).findByTestId('cards-preparing')).textContent).toBe('1 kart hazırlanıyor');
    expect(within(log).queryByTestId('card-strip')).toBeNull();
    expect(within(log).queryByRole('article', { name: 'atlas paralelliği' })).toBeNull();

    // The answer is complete: the text first, the cards below it.
    state.messages = [...state.messages, msg('m3', 3, 'assistant', 'Kartı hazırladım, inceleyebilirsin.')];
    state.turn = null;
    act(() => {
      invalidate('chat');
    });
    const strip = await within(log).findByTestId('card-strip');
    expect(within(log).queryByTestId('cards-preparing')).toBeNull();
    const answer = within(log).getByText('Kartı hazırladım, inceleyebilirsin.');
    expect(answer.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // One card: collapsed (kind, title, state chip, primary action), no carousel controls.
    expect(strip.getAttribute('data-count')).toBe('1');
    expect(within(strip).queryByRole('button', { name: 'Sonraki kart' })).toBeNull();
    const toggle = within(strip).getByRole('button', { name: 'Kartı aç: atlas paralelliği' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(strip).getByText('Henüz çalışmadı')).toBeTruthy();
    expect(within(strip).queryByRole('article')).toBeNull();
    // The primary action opens the full card and focuses its first control.
    fireEvent.click(within(strip).getByRole('button', { name: 'İncele ve onayla' }));
    const card = await within(strip).findByRole('article', { name: 'atlas paralelliği' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => {
      expect(card.contains(document.activeElement)).toBe(true);
    });
    expect(within(card).getByRole('button', { name: 'Onayla' })).toBeTruthy();
  });

  it('cards still waiting for the person come first; otherwise the turn order is kept (owner 2026-10-27)', async () => {
    const a = draft('Onaylanmış kart', { state: 'confirmed', decidedAt: iso(MIN), result: { jobId: JOB } });
    const b = draft('Bekleyen birinci');
    const c = draft('Reddedilmiş kart', { state: 'dismissed', decidedAt: iso(MIN) });
    const d = draft('Bekleyen ikinci');
    open({
      messages: [
        msg('m1', 1, 'user', 'dört şey'),
        msg('m2', 2, 'tool', 'x', { name: 'propose_worker_config', draftId: a.id }),
        msg('m3', 3, 'tool', 'x', { name: 'propose_worker_config', draftId: b.id }),
        msg('m4', 4, 'tool', 'x', { name: 'propose_worker_config', draftId: c.id }),
        msg('m5', 5, 'tool', 'x', { name: 'propose_worker_config', draftId: d.id }),
        msg('m6', 6, 'assistant', 'Dört kart.'),
      ],
      drafts: [a, b, c, d],
      turn: null,
    });
    const strip = await screen.findByTestId('card-strip');
    const titles = within(strip)
      .getAllByTestId('strip-card')
      .map((el) => el.textContent);
    expect(
      titles.map((x) =>
        ['Bekleyen birinci', 'Bekleyen ikinci', 'Onaylanmış kart', 'Reddedilmiş kart'].find((tt) =>
          x.includes(tt),
        ),
      ),
    ).toEqual(['Bekleyen birinci', 'Bekleyen ikinci', 'Onaylanmış kart', 'Reddedilmiş kart']);
  });

  it('several cards: one scrollable row with ‹ ›, "1/3", arrow keys, Enter opens, Escape collapses; one open at a time', async () => {
    const user = userEvent.setup();
    const a = draft('Birinci kart');
    const b = draft('İkinci kart', {
      state: 'confirmed',
      decidedAt: iso(MIN),
      result: { jobId: JOB },
    });
    const c = draft('Üçüncü kart');
    open({
      messages: [
        msg('m1', 1, 'user', 'üç şey'),
        msg('m2', 2, 'tool', 'x', { name: 'propose_worker_config', draftId: a.id }),
        msg('m3', 3, 'tool', 'x', { name: 'propose_worker_config', draftId: b.id }),
        msg('m4', 4, 'tool', 'x', { name: 'propose_worker_config', draftId: c.id }),
        msg('m5', 5, 'assistant', 'Üç kart.'),
      ],
      drafts: [a, b, c],
      turn: null,
    });
    const strip = await screen.findByTestId('card-strip');
    expect(strip.getAttribute('aria-roledescription')).toBe('carousel');
    expect(strip.getAttribute('aria-label')).toBe('Bu yanıtın kartları (3)');
    expect(within(strip).getAllByTestId('strip-card')).toHaveLength(3);
    const position = within(strip).getByTestId('strip-position');
    expect(position.textContent).toBe('1/3');
    expect(position.getAttribute('aria-label')).toBe('3 karttan 1.');
    const prev = within(strip).getByRole('button', { name: 'Önceki kart' });
    const next = within(strip).getByRole('button', { name: 'Sonraki kart' });
    expect((prev as HTMLButtonElement).disabled).toBe(true);
    await user.click(next);
    expect(position.textContent).toBe('2/3');
    await user.click(next);
    expect(position.textContent).toBe('3/3');
    expect((next as HTMLButtonElement).disabled).toBe(true);
    // Decided cards show their result instead of an action; open ones keep "İncele ve onayla".
    expect(within(strip).getByRole('link', { name: 'İşi aç' }).getAttribute('href')).toBe(`/jobs/${JOB}`);
    expect(within(strip).getAllByRole('button', { name: 'İncele ve onayla' })).toHaveLength(2);

    // Keyboard: a roving tab stop on the card toggles; arrows, Home and End move it.
    const t1 = within(strip).getByRole('button', { name: 'Kartı aç: Birinci kart' });
    const t2 = within(strip).getByRole('button', { name: 'Kartı aç: İkinci kart' });
    const t3 = within(strip).getByRole('button', { name: 'Kartı aç: Üçüncü kart' });
    act(() => {
      t1.focus();
    });
    expect(position.textContent).toBe('1/3');
    expect(t1.tabIndex).toBe(0);
    expect(t2.tabIndex).toBe(-1);
    // The confirmed "İkinci kart" waits for nobody, so it comes last: Birinci, Üçüncü, İkinci.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(t3);
    expect(position.textContent).toBe('2/3');
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(t2);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(t1);
    // Enter opens the card inline below the row; another card replaces it; Escape collapses and returns focus.
    await user.keyboard('{Enter}');
    expect(await within(strip).findByRole('article', { name: 'Birinci kart' })).toBeTruthy();
    expect(t1.getAttribute('aria-expanded')).toBe('true');
    await user.click(t3);
    expect(await within(strip).findByRole('article', { name: 'Üçüncü kart' })).toBeTruthy();
    expect(within(strip).queryByRole('article', { name: 'Birinci kart' })).toBeNull();
    expect(within(strip).getAllByTestId('strip-panel')).toHaveLength(1);
    const panel = within(strip).getByTestId('strip-panel');
    act(() => {
      within(panel).getByRole('button', { name: 'Onayla' }).focus();
    });
    await user.keyboard('{Escape}');
    expect(within(strip).queryByTestId('strip-panel')).toBeNull();
    expect(document.activeElement).toBe(t3);
    // The collapse button closes it too.
    await user.click(t2);
    await user.click(await within(strip).findByTestId('strip-collapse'));
    expect(within(strip).queryByTestId('strip-panel')).toBeNull();
  });
});
