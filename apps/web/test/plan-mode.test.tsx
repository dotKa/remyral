// p18-plan-mode (docs/design/p18-plan-mode.md §3, §4, §6): plan mode in the composer (Planla chip, /plan, violet edge,
// header badge, older-machine fallback), the plan panel at each width (desktop column, docked under the details, tablet
// bar + drawer, phone pill + sheet), review (approve disabled while decisions are open, request changes, a 409 with the
// current plan), decisions answered from the panel without a turn, the plan / proposal cards in the strip, live progress
// announcements, rev ordering of plan events, and reduced motion.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { messagesFor } from '@remyral/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Plan, parsePlan } from '../src/api/plans';
import type { AuthState } from '../src/auth/AuthProvider';
import { expandSlash, planCommand } from '../src/diyalog/compose/slash';
import { announcements, newerPlan, phasesOf, progressText } from '../src/diyalog/plan/planModel';
import { pushPlanEvent, resetPlanStore } from '../src/diyalog/plan/planStore';
import { chatItems } from '../src/diyalog/ops/timeline';
import { type Handler, renderApp, stubCookies } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const tr = messagesFor('tr').plan;
const en = () => messagesFor('en').plan;
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
const PLAN = '7c0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f';
const Q1 = '8d0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f';
const thread = { id: THREAD, title: 'Sürüm', archived: false, createdAt: iso(90 * MIN), updatedAt: iso(MIN) };

function item(key: string, status: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    phase: 0,
    phaseTitle: 'Hazırlık',
    position: 0,
    title: `Madde ${key}`,
    activeTitle: null,
    detail: null,
    status,
    owner: 'assistant',
    project: null,
    dependsOn: [],
    estimate: null,
    links: [],
    note: null,
    statusBy: 'assistant',
    decisionOpen: false,
    ...over,
  };
}

function rawPlan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PLAN,
    threadId: THREAD,
    title: 'Sürüm 2.4 yayını',
    goal: 'Testleri geçmiş halde yayına çık.',
    assumptions: [],
    risks: ['Flaky test'],
    state: 'in_review',
    version: 2,
    rev: 5,
    approvedVersion: null,
    stalled: null,
    createdAt: iso(20 * MIN),
    updatedAt: iso(MIN),
    closedAt: null,
    phases: [
      { index: 0, title: 'Hazırlık' },
      { index: 1, title: 'Yayın' },
    ],
    items: [
      item('a', 'pending', { position: 0 }),
      item('b', 'pending', { position: 1, owner: 'job', decisionOpen: true }),
      item('c', 'pending', { phase: 1, phaseTitle: 'Yayın', position: 0, owner: 'user' }),
    ],
    decisions: [
      {
        id: Q1,
        itemKey: 'b',
        prompt: 'Deploy ortamı?',
        kind: 'single',
        options: [{ label: 'preview' }, { label: 'production' }],
        recommended: 'preview',
        rationale: 'Önce doğrula.',
        state: 'pending',
        answers: null,
        answer: null,
        createdAt: iso(5 * MIN),
      },
    ],
    progress: { done: 0, total: 3, skipped: 0, remainingMinutes: null },
    lastChange: { version: 2, author: 'assistant', reason: 'x', added: 1, removed: 0, changed: 1, moved: 0 },
    ...over,
  };
}
const asPlan = (o: Record<string, unknown>): Plan => {
  const p = parsePlan(o);
  if (p === null) throw new Error('bad plan fixture');
  return p;
};

const question = {
  id: Q1,
  source: 'assistant',
  jobId: null,
  threadId: THREAD,
  project: null,
  title: null,
  questions: [
    {
      id: 'q1',
      prompt: 'Deploy ortamı?',
      kind: 'single',
      options: [{ label: 'production' }, { label: 'preview' }],
      recommended: 'preview',
      rationale: 'Önce doğrula.',
    },
  ],
  state: 'pending',
  createdAt: iso(5 * MIN),
  deadlineAt: null,
  closedAt: null,
  closeReason: null,
  answers: null,
  answeredBy: null,
  answeredAt: null,
  planId: PLAN,
  planItemKey: 'b',
};

const msg = (seq: number, role: string, content: string, meta: unknown = null): Record<string, unknown> => ({
  id: `00000000-0000-4000-8000-0000000000${String(10 + seq)}`,
  seq,
  role,
  content,
  meta,
  turnId: null,
  createdAt: iso((20 - seq) * MIN),
});

function routes(opts: {
  plan?: Record<string, unknown> | null;
  mode?: string | null;
  ready?: boolean;
  messages?: unknown[];
  questions?: unknown[];
  extra?: Record<string, Handler>;
}): Record<string, Handler> {
  return {
    'GET /api/chat/status': () => ({
      status: 200,
      body: {
        enabled: true,
        available: true,
        code: null,
        message: null,
        worker: { id: 'w1', name: 'kestrel', online: true },
        runtime: 'claude-code',
        model: null,
        limits: { turnsPerUserPer10Min: 30, userDailyTokens: null },
        input: null,
        plan: opts.ready ?? true,
      },
    }),
    'GET /api/chat/threads': () => ({ status: 200, body: { items: [thread], nextCursor: null } }),
    [`GET /api/chat/threads/${THREAD}`]: () => ({
      status: 200,
      body: {
        thread,
        messages: opts.messages ?? [msg(1, 'user', 'planla')],
        drafts: [],
        turn: null,
        watches: [],
        starred: [],
        questions: opts.questions ?? [],
        plan: { mode: opts.mode ?? null, active: opts.plan === undefined ? null : opts.plan },
      },
    }),
    [`POST /api/chat/threads/${THREAD}/read`]: () => ({
      status: 200,
      body: { threadId: THREAD, lastReadSeq: 2, lastReadAt: iso(0), unreadCount: 0 },
    }),
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/notifications?limit=20': () => ({ status: 200, body: { items: [], nextCursor: null } }),
    'GET /api/usage-limits/overview': () => ({
      status: 200,
      body: {
        generatedAt: iso(0),
        settings: { nearThreshold: 80, notifyNear: true },
        entries: [],
        otherLimits: [],
      },
    }),
    ...(opts.extra ?? {}),
  };
}

/** `min-width` media queries answer for a window `width` px wide (16 px rem). */
function setWidth(width: number, reduce = false): void {
  vi.stubGlobal('matchMedia', (q: string) => {
    const min = /min-width:\s*([\d.]+)rem/.exec(q);
    const maxPx = /max-width:\s*([\d.]+)px/.exec(q);
    const matches = q.includes('prefers-reduced-motion')
      ? reduce
      : min !== null
        ? width >= Number(min[1]) * 16
        : maxPx !== null
          ? width <= Number(maxPx[1])
          : false;
    return {
      matches,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    };
  });
  window.matchMedia = globalThis.matchMedia;
}

function open(r: Record<string, Handler>) {
  return renderApp({ path: `/chat/${THREAD}`, initialState: signedIn, routes: r });
}

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-1');
  window.localStorage.clear();
  resetPlanStore();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('plan model (pure)', () => {
  it('rev ordering: a stale event never rolls the plan back; an active new plan replaces a closed one', () => {
    const a = asPlan(rawPlan({ rev: 5 }));
    const b = asPlan(rawPlan({ rev: 7, state: 'executing' }));
    expect(newerPlan(a, b)).toBe(b);
    expect(newerPlan(b, a)).toBe(b);
    const closed = asPlan(rawPlan({ state: 'superseded', rev: 99 }));
    const fresh = asPlan(rawPlan({ id: '9d0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f', rev: 1 }));
    expect(newerPlan(closed, fresh)).toBe(fresh);
    expect(newerPlan(null, a)).toBe(a);
    expect(newerPlan(a, null)).toBe(a);
  });

  it('phases fold done items under the open filter; progress says done / total and the time left', () => {
    const p = asPlan(
      rawPlan({
        items: [
          item('a', 'done'),
          item('b', 'in_progress', { position: 1, estimate: 90 }),
          item('c', 'skipped', { position: 2 }),
        ],
        progress: { done: 1, total: 2, skipped: 1, remainingMinutes: 90 },
      }),
    );
    const [ph] = phasesOf(p, 'open');
    expect(ph?.items.map((i) => i.key)).toEqual(['b']);
    expect(ph?.folded).toBe(2);
    expect(phasesOf(p, 'all')[0]?.items.length).toBe(3);
    expect(progressText(p, tr)).toBe('1/2 · ~1 sa 30 dk kaldı');
    expect(progressText(p, en())).toBe('1 of 2 · ~1 h 30 min left');
  });

  it('live region sentences: item done with the next one, started, blocked, decisions, state', () => {
    const before = asPlan(
      rawPlan({
        state: 'executing',
        items: [item('a', 'in_progress'), item('b', 'pending', { position: 1 })],
        decisions: [],
      }),
    );
    const after = asPlan(
      rawPlan({
        state: 'executing',
        items: [item('a', 'done'), item('b', 'in_progress', { position: 1, activeTitle: 'B yapılıyor' })],
      }),
    );
    expect(announcements(before, after, tr)).toEqual([
      'Madde 1/2 tamamlandı: Madde a.',
      'Sıradaki: B yapılıyor.',
      'Başladı: B yapılıyor.',
      'Bir karar bekleniyor.',
    ]);
    expect(announcements(null, after, tr)).toEqual([]);
    const blocked = asPlan(
      rawPlan({ state: 'paused', items: [item('a', 'done'), item('b', 'blocked', { position: 1 })] }),
    );
    expect(announcements(after, blocked, en())).toEqual(['Blocked: Madde b.', 'Plan: Paused.']);
  });

  it('/plan sets a field (not an intent line); the strip gets plan and proposal cards from tool lines', () => {
    expect(planCommand('/plan 2.4’ü yayına hazırla')).toEqual({ arg: '2.4’ü yayına hazırla' });
    expect(planCommand('/planla')).toEqual({ arg: '' });
    expect(planCommand('/plank')).toBeNull();
    expect(expandSlash('/onaylar')).toMatchObject({ ok: true });
    const items = chatItems({
      thread,
      messages: [
        msg(1, 'user', 'yap') as never,
        msg(2, 'tool', 'plan_propose: x', {
          name: 'plan_propose',
          isError: false,
          proposal: { reason: 'Büyük' },
        }) as never,
        msg(3, 'tool', 'plan_create: plan v1', {
          name: 'plan_create',
          isError: false,
          planId: PLAN,
          planVersion: 1,
        }) as never,
        msg(4, 'assistant', 'tamam') as never,
      ],
      drafts: [],
      turn: null,
      watches: [],
      knowledge: null,
      starred: [],
    });
    const strip = items.find((i) => i.kind === 'cards');
    expect(strip?.kind === 'cards' ? strip.cards.map((c) => c.kind) : []).toEqual(['proposal', 'plan']);
    expect(
      strip?.kind === 'cards' && strip.cards[0]?.kind === 'proposal' ? strip.cards[0].answered : null,
    ).toBe(false);
  });
});

describe('strip: one plan card per plan and turn', () => {
  it('a turn that writes and then revises the plan shows a single card (its last write)', () => {
    const tool = (seq: number, name: string, v: number) =>
      msg(seq, 'tool', `${name}: plan v${String(v)}`, {
        name,
        isError: false,
        planId: PLAN,
        planVersion: v,
      }) as never;
    const items = chatItems({
      thread,
      messages: [
        msg(1, 'user', 'planla') as never,
        tool(2, 'plan_create', 1),
        tool(3, 'plan_update_items', 1),
        tool(4, 'plan_update_items', 2),
        msg(5, 'assistant', 'hazır') as never,
      ],
      drafts: [],
      turn: null,
      watches: [],
      knowledge: null,
      starred: [],
    });
    const strip = items.find((i) => i.kind === 'cards');
    const cards = strip?.kind === 'cards' ? strip.cards : [];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: 'plan', planId: PLAN, version: 2 });
  });
});

describe('composer: plan mode', () => {
  it('the Planla chip turns plan mode on; the composer shows the violet line with ✕ and the header the badge', async () => {
    setWidth(1440);
    let mode: string | null = null;
    const r = routes({
      extra: {
        [`PUT /api/chat/threads/${THREAD}/plan-mode`]: (req) => {
          mode = (req.body as { on: boolean }).on ? iso(0) : null;
          return { status: 200, body: { mode } };
        },
      },
    });
    const base = r[`GET /api/chat/threads/${THREAD}`];
    r[`GET /api/chat/threads/${THREAD}`] = (req) => {
      const out = base?.(req) ?? { status: 500 };
      return { ...out, body: { ...(out.body as object), plan: { mode, active: null } } };
    };
    const app = open(r);
    const chip = await screen.findByTestId('dy-plan-chip');
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(chip);
    await screen.findByTestId('dy-plan-mode');
    expect(screen.getByText(tr.mode.label)).toBeTruthy();
    expect(screen.getByTestId('dy-composer-box').hasAttribute('data-plan-mode')).toBe(true);
    expect(await screen.findByTestId('dy-plan-badge')).toBeTruthy();
    await userEvent.click(screen.getByTestId('dy-plan-mode-leave'));
    await waitFor(() => {
      expect(screen.queryByTestId('dy-plan-mode')).toBeNull();
    });
    expect(app.requests.filter((q) => q.method === 'PUT').map((q) => q.body)).toEqual([
      { on: true },
      { on: false },
    ]);
  });

  it('/plan <metin> sends the words with mode plan', async () => {
    setWidth(1440);
    const app = open(
      routes({
        extra: {
          [`POST /api/chat/threads/${THREAD}/messages`]: () => ({
            status: 202,
            body: { message: msg(2, 'user', 'x'), turnId: 't1', dropped: [] },
          }),
        },
      }),
    );
    const field = await screen.findByTestId('dy-composer-field');
    await userEvent.type(field, '/plan sürümü hazırla{Enter}');
    await waitFor(() => {
      expect(app.requests.some((q) => q.method === 'POST' && q.url.endsWith('/messages'))).toBe(true);
    });
    const sent = app.requests.find((q) => q.method === 'POST' && q.url.endsWith('/messages'));
    expect(sent?.body).toMatchObject({ text: 'sürümü hazırla', mode: 'plan' });
  });

  it('an older assistant machine: the chip is off and says why', async () => {
    setWidth(1440);
    open(routes({ ready: false }));
    const chip = await screen.findByTestId('dy-plan-chip');
    await waitFor(() => {
      expect((chip as HTMLButtonElement).disabled).toBe(true);
    });
    expect(chip.getAttribute('title')).toBe(tr.mode.unavailable);
  });
});

describe('the plan panel at each width', () => {
  it('desktop: no plan → nothing; a plan → the right column with the review actions', async () => {
    setWidth(1440);
    const first = open(routes({}));
    await screen.findByTestId('dy-composer-field');
    expect(screen.queryByTestId('plan-column')).toBeNull();
    first.unmount();
    open(routes({ plan: rawPlan(), questions: [question] }));
    const column = await screen.findByTestId('plan-column');
    expect(column.tagName).toBe('ASIDE');
    expect(column.getAttribute('aria-label')).toBe('Plan');
    // p18-plan-header: row 1 = meta + actions (one line), row 2 = the title alone at full width.
    const top = within(column).getByTestId('plan-header-top');
    const heading = within(column).getByRole('heading', { level: 2 });
    expect(top.contains(heading)).toBe(false);
    expect(top.nextElementSibling).toBe(heading);
    expect(top.className).toContain('flex-nowrap');
    expect(within(top).getByTestId('plan-header-actions')).toBeTruthy();
    // The last change made this version: the version is not repeated under "Plan v2".
    expect(column.textContent).toContain(tr.changes({ n: 2 }));
    expect(column.textContent).not.toContain(tr.lastChange({ v: 2, n: 2 }));
    const approve = within(column).getByTestId<HTMLButtonElement>('plan-approve');
    expect(approve.disabled).toBe(true);
    expect(approve.textContent).toContain(tr.actions.approveLeft({ n: 1 }));
    // The decision shows the recommended option first with its badge and the rationale.
    const decisions = within(column).getByTestId('plan-decisions');
    expect(within(decisions).getByTestId('question-recommended').textContent).toBe(tr.decisions.recommended);
    const options = within(decisions).getAllByRole('radio');
    expect(options[0]?.closest('label')?.textContent).toContain('preview');
    expect(within(column).getAllByRole('list').length).toBeGreaterThan(0);
    expect(within(column).getByText('Madde b').closest('[data-testid="plan-item"]')?.textContent).toContain(
      tr.decisions.needed,
    );
  });

  it('desktop with the details open: the plan docks under them (mini line, expands)', async () => {
    setWidth(1440);
    window.localStorage.setItem('remyral.chat.sidebar.u1', 'open');
    open(routes({ plan: rawPlan({ state: 'executing', decisions: [] }) }));
    const details = await screen.findByTestId('dy-details');
    const dock = await within(details).findByTestId('plan-dock');
    expect(screen.queryByTestId('plan-column')).toBeNull();
    const mini = within(dock).getByTestId('plan-mini-dock');
    expect(mini.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(mini);
    expect(mini.getAttribute('aria-expanded')).toBe('true');
    expect(await within(dock).findByTestId('plan-body')).toBeTruthy();
    expect(within(dock).getByTestId('plan-grip').getAttribute('role')).toBe('separator');
  });

  it('tablet: a bar under the context strip opens a drawer from the right', async () => {
    setWidth(800);
    open(routes({ plan: rawPlan({ state: 'executing', decisions: [] }) }));
    const bar = await screen.findByTestId('plan-mini-bar');
    expect(screen.queryByTestId('plan-column')).toBeNull();
    await userEvent.click(bar);
    const drawer = await screen.findByTestId('plan-drawer');
    expect(drawer.className).toContain('dy-m-drawer-right');
    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('plan-drawer')).toBeNull();
    });
  });

  it('phone: a pill above the composer opens the bottom sheet (a modal dialog)', async () => {
    setWidth(390);
    open(routes({ plan: rawPlan({ state: 'executing', decisions: [] }) }));
    const pill = await screen.findByTestId('plan-mini-pill');
    expect(pill.textContent).toContain('Sürüm 2.4 yayını');
    await userEvent.click(pill);
    const sheet = await screen.findByTestId('plan-sheet');
    expect(sheet.tagName).toBe('DIALOG');
    expect(sheet.getAttribute('data-snap')).toBe('half');
    const handle = within(sheet).getByTestId('plan-sheet-handle');
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(sheet.getAttribute('data-snap')).toBe('full');
  });
});

describe('review and decisions', () => {
  it('a decision answered from the panel starts no turn; the plan card and panel follow the same row', async () => {
    setWidth(1440);
    let answered = false;
    const r = routes({
      plan: rawPlan(),
      questions: [question],
      extra: {
        [`POST /api/chat/threads/${THREAD}/questions/${Q1}/answer`]: () => {
          answered = true;
          return {
            status: 200,
            body: {
              question: { ...question, state: 'answered', answers: [{ id: 'q1', choices: ['preview'] }] },
              turnId: null,
            },
          };
        },
      },
    });
    const app = open(r);
    const column = await screen.findByTestId('plan-column');
    const decisions = within(column).getByTestId('plan-decisions');
    await userEvent.click(within(decisions).getAllByRole('radio')[0] as HTMLElement);
    await userEvent.click(within(decisions).getByRole('button', { name: /gönder/i }));
    await waitFor(() => {
      expect(answered).toBe(true);
    });
    expect(app.requests.some((q) => q.url.endsWith('/messages'))).toBe(false);
  });

  // p20-quick: the disabled Onayla gets a way to the decisions that keep it disabled.
  it('"Kalan N kararı göster" scrolls to the decisions and focuses the first open one; Onayla stays disabled', async () => {
    setWidth(1440);
    open(routes({ plan: rawPlan(), questions: [question] }));
    const column = await screen.findByTestId('plan-column');
    expect(within(column).getByTestId<HTMLButtonElement>('plan-approve').disabled).toBe(true);
    const show = within(column).getByTestId('plan-show-left');
    expect(show.textContent).toBe(tr.actions.showLeft({ n: 1 }));
    await userEvent.click(show);
    const decisions = within(column).getByTestId('plan-decisions');
    await waitFor(() => {
      expect(document.activeElement).toBe(within(decisions).getAllByRole('radio')[0]);
    });
    expect(within(column).getByTestId<HTMLButtonElement>('plan-approve').disabled).toBe(true);
  });

  it('no open decision: no "Kalan N kararı göster", Onayla is enabled', async () => {
    setWidth(1440);
    open(routes({ plan: rawPlan({ decisions: [] }) }));
    const column = await screen.findByTestId('plan-column');
    expect(within(column).queryByTestId('plan-show-left')).toBeNull();
    expect(within(column).getByTestId<HTMLButtonElement>('plan-approve').disabled).toBe(false);
  });

  it('the chat plan card: "Kalan N kararı göster" opens the plan panel at its first decision', async () => {
    setWidth(800);
    open(
      routes({
        plan: rawPlan(),
        questions: [question],
        messages: [
          msg(1, 'user', 'planla'),
          msg(2, 'tool', 'plan_create: plan v2', {
            name: 'plan_create',
            isError: false,
            planId: PLAN,
            planVersion: 2,
          }),
          msg(3, 'assistant', 'hazır'),
        ],
      }),
    );
    const strip = await screen.findByTestId('card-strip');
    await userEvent.click(within(strip).getByTestId('strip-primary'));
    const card = await screen.findByTestId('plan-card');
    expect(screen.queryByTestId('plan-drawer')).toBeNull();
    await userEvent.click(within(card).getByTestId('plan-show-left'));
    const drawer = await screen.findByTestId('plan-drawer');
    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(within(drawer).getByTestId('plan-decisions')).getAllByRole('radio')[0],
      );
    });
  });

  it('approve at a stale version shows "Plan güncellendi" and takes the current plan', async () => {
    setWidth(1440);
    const current = rawPlan({ version: 3, rev: 9, decisions: [], items: [item('a', 'pending')] });
    open(
      routes({
        plan: rawPlan({ decisions: [], items: [item('a', 'pending')] }),
        extra: {
          [`POST /api/chat/plans/${PLAN}/approve`]: () => ({
            status: 409,
            body: { error: 'plan_version_conflict', message: 'x', plan: current },
          }),
        },
      }),
    );
    const column = await screen.findByTestId('plan-column');
    await userEvent.click(within(column).getByTestId('plan-approve'));
    expect(await within(column).findByTestId('plan-conflict')).toBeTruthy();
    expect(within(column).getByText(tr.version({ v: 3 }))).toBeTruthy();
  });

  it('request changes sends the note at the plan version', async () => {
    setWidth(1440);
    const app = open(
      routes({
        plan: rawPlan({ decisions: [] }),
        extra: {
          [`POST /api/chat/plans/${PLAN}/request-changes`]: () => ({ status: 200, body: { turnId: 't2' } }),
        },
      }),
    );
    const column = await screen.findByTestId('plan-column');
    await userEvent.click(within(column).getByTestId('plan-request-changes'));
    await userEvent.type(within(column).getByLabelText(tr.actions.changeNote), 'Önce preview');
    await userEvent.click(within(column).getByRole('button', { name: tr.actions.send }));
    await waitFor(() => {
      expect(app.requests.find((q) => q.url.endsWith('/request-changes'))?.body).toEqual({
        version: 2,
        note: 'Önce preview',
      });
    });
  });
});

describe('live progress', () => {
  it('a plan event with a newer rev updates the panel and the live region announces it', async () => {
    setWidth(1440);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const start = rawPlan({
        state: 'executing',
        decisions: [],
        items: [item('a', 'in_progress'), item('b', 'pending', { position: 1 })],
      });
      open(routes({ plan: start }));
      const column = await screen.findByTestId('plan-column');
      expect(
        within(column)
          .getByText('Madde a')
          .closest('[data-testid="plan-item"]')
          ?.hasAttribute('data-current'),
      ).toBe(true);
      // A stale event (lower rev) is ignored.
      pushPlanEvent(THREAD, { plan: rawPlan({ rev: 1, state: 'executing', items: [item('a', 'done')] }) });
      expect(
        within(column).getByText('Madde a').closest('[data-testid="plan-item"]')?.getAttribute('data-status'),
      ).toBe('in_progress');
      pushPlanEvent(THREAD, {
        plan: rawPlan({
          rev: 6,
          state: 'executing',
          decisions: [],
          items: [item('a', 'done'), item('b', 'in_progress', { position: 1 })],
          progress: { done: 1, total: 2, skipped: 0, remainingMinutes: null },
        }),
      });
      await waitFor(() => {
        expect(within(column).getByTestId('plan-progress').getAttribute('aria-valuenow')).toBe('50');
      });
      vi.advanceTimersByTime(1100);
      await waitFor(() => {
        expect(within(column).getByTestId('plan-live').textContent).toBe(
          'Madde 1/2 tamamlandı: Madde a. Sıradaki: Madde b. Başladı: Madde b.',
        );
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reduced motion: every plan motion class is off (system and in-app switch)', () => {
    const css = readFileSync(join(__dirname, '../src/diyalog/motion.css'), 'utf8');
    const block = css.slice(css.indexOf('p18-plan-mode'));
    expect(block).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*dy-plan-ring, \.dy-plan-row, \.dy-plan-row::before, \.dy-plan-chev, \.dy-plan-title[\s\S]*transition: none !important/,
    );
    expect(block).toMatch(
      /\[data-motion='reduce'\] :is\(\.dy-plan-ring[\s\S]*dialog\.dy-plan-sheet[\s\S]*transition: none !important/,
    );
  });
});

describe('the strip cards (English)', () => {
  it('the proposal card offers Plan it / Do it now; Plan it sends in plan mode', async () => {
    setWidth(1440);
    const app = renderApp({
      path: `/chat/${THREAD}`,
      initialState: signedIn,
      routes: routes({
        messages: [
          msg(1, 'user', 'release 2.4'),
          msg(2, 'tool', 'plan_propose', {
            name: 'plan_propose',
            isError: false,
            proposal: { reason: 'Many steps.' },
          }),
          msg(3, 'assistant', 'Shall I plan it first?'),
        ],
        extra: {
          [`POST /api/chat/threads/${THREAD}/messages`]: () => ({
            status: 202,
            body: { message: msg(4, 'user', 'x'), turnId: 't1', dropped: [] },
          }),
        },
      }),
    });
    const strip = await screen.findByTestId('card-strip');
    await userEvent.click(within(strip).getByTestId('strip-primary'));
    await userEvent.click(await screen.findByTestId('plan-proposal-plan'));
    await waitFor(() => {
      expect(app.requests.find((q) => q.url.endsWith('/messages'))?.body).toMatchObject({ mode: 'plan' });
    });
  });

  it('the English catalog has every plan word', () => {
    expect(en().mode.label).toBe('Plan mode — the assistant only reviews and writes a plan');
    expect(Object.keys(en().states)).toEqual(Object.keys(tr.states));
    expect(en().stalled.title).toBe('Shall I continue the plan?');
  });
});

// p18-plan-autonomy: "Otonom yürüt" on the review (on by default, sent with the approval), the "Otonom" chip while the
// plan runs by itself, "Senden bekleniyor" on an item that waits for the person's card, and the ⋯ switch.
describe('autonomous execution (p18-plan-autonomy)', () => {
  it('approve: "Otonom yürüt" is on by default and is sent; switched off it sends false', async () => {
    setWidth(1440);
    const approved = rawPlan({
      state: 'executing',
      autonomous: true,
      rev: 6,
      decisions: [],
      items: [item('a', 'pending')],
    });
    const app = open(
      routes({
        plan: rawPlan({ decisions: [], items: [item('a', 'pending')] }),
        extra: { [`POST /api/chat/plans/${PLAN}/approve`]: () => ({ status: 200, body: approved }) },
      }),
    );
    const column = await screen.findByTestId('plan-column');
    const toggle = within(column).getByTestId('plan-autonomous-toggle');
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(within(column).getByText(tr.autonomy.toggle)).toBeTruthy();
    expect(within(column).getByText(tr.autonomy.toggleHint)).toBeTruthy();
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(toggle);
    await userEvent.click(within(column).getByTestId('plan-approve'));
    await waitFor(() => {
      expect(app.requests.find((q) => q.url.endsWith('/approve'))?.body).toEqual({
        version: 2,
        autonomous: true,
      });
    });
    expect(await within(column).findByTestId('plan-autonomous')).toBeTruthy();
  });

  it('switched off before approving, the approval says autonomous: false', async () => {
    setWidth(1440);
    const app = open(
      routes({
        plan: rawPlan({ decisions: [], items: [item('a', 'pending')] }),
        extra: {
          [`POST /api/chat/plans/${PLAN}/approve`]: () => ({
            status: 200,
            body: rawPlan({
              state: 'executing',
              autonomous: false,
              rev: 6,
              decisions: [],
              items: [item('a', 'pending')],
            }),
          }),
        },
      }),
    );
    const column = await screen.findByTestId('plan-column');
    await userEvent.click(within(column).getByTestId('plan-autonomous-toggle'));
    await userEvent.click(within(column).getByTestId('plan-approve'));
    await waitFor(() => {
      expect(app.requests.find((q) => q.url.endsWith('/approve'))?.body).toEqual({
        version: 2,
        autonomous: false,
      });
    });
    await waitFor(() => {
      expect(within(column).queryByTestId('plan-review')).toBeNull();
    });
    expect(within(column).queryByTestId('plan-autonomous')).toBeNull();
  });

  it('executing autonomously: the header chip, "Senden bekleniyor" on a waiting item; ⋯ turns it off and on', async () => {
    setWidth(1440);
    let autonomous = true;
    const exec = (): Record<string, unknown> =>
      rawPlan({
        state: 'executing',
        autonomous,
        rev: autonomous ? 8 : 9,
        decisions: [],
        items: [
          item('a', 'in_progress', { owner: 'job', awaitsUser: true, failures: 1 }),
          item('b', 'pending', { position: 1 }),
        ],
      });
    const app = open(
      routes({
        plan: exec(),
        extra: {
          [`POST /api/chat/plans/${PLAN}/autonomy`]: (req) => {
            autonomous = (req.body as { autonomous: boolean }).autonomous;
            return { status: 200, body: exec() };
          },
        },
      }),
    );
    const column = await screen.findByTestId('plan-column');
    const chip = within(column).getByTestId('plan-autonomous');
    expect(chip.textContent).toContain(tr.autonomy.chip);
    expect(within(column).getByTestId('plan-item-awaits').textContent).toBe(tr.autonomy.awaitsUser);
    expect(within(column).getByTestId('plan-item-failures').textContent).toBe(tr.autonomy.failures({ n: 1 }));
    await userEvent.click(within(column).getByRole('button', { name: tr.actions.menu }));
    await userEvent.click(await screen.findByRole('menuitem', { name: tr.autonomy.turnOff }));
    await waitFor(() => {
      expect(app.requests.find((q) => q.url.endsWith('/autonomy'))?.body).toEqual({ autonomous: false });
    });
    await waitFor(() => {
      expect(within(column).queryByTestId('plan-autonomous')).toBeNull();
    });
    await userEvent.click(within(column).getByRole('button', { name: tr.actions.menu }));
    expect(await screen.findByRole('menuitem', { name: tr.autonomy.turnOn })).toBeTruthy();
  });

  it('the English catalog has the autonomy words', () => {
    expect(Object.keys(en().autonomy)).toEqual(Object.keys(tr.autonomy));
    expect(en().stalled.reasons.item_failed).toMatch(/3 times/);
    expect(tr.autonomy.toggleHint).toBe('onaylı plan adımları kart beklemeden çalışır');
  });
});

/** p18-plans-ui: the Planlar screen's link (`/chat/:id?plan=<id>`) shows that plan when the conversation opens. */
describe('a plan link into its conversation (p18-plans-ui)', () => {
  const EARLIER = '8d0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f';
  const linkTo = (planId: string, r: Record<string, Handler>) =>
    renderApp({ path: `/chat/${THREAD}?plan=${planId}`, initialState: signedIn, routes: r });

  it('the active plan: the plan column opens although the person had closed it', async () => {
    setWidth(1440);
    window.localStorage.setItem('remyral.chat.plan.u1', 'closed');
    linkTo(PLAN, routes({ plan: rawPlan(), questions: [question] }));
    expect(await screen.findByTestId('plan-column')).toBeTruthy();
  });

  it('an earlier plan: the details open on the Planlar tab with its read-only view', async () => {
    setWidth(1440);
    linkTo(
      EARLIER,
      routes({
        plan: rawPlan(),
        questions: [question],
        extra: {
          [`GET /api/chat/threads/${THREAD}/plans`]: () => ({
            status: 200,
            body: {
              active: null,
              mode: null,
              history: [
                {
                  id: EARLIER,
                  title: 'Eski plan',
                  state: 'done',
                  version: 1,
                  done: 2,
                  total: 2,
                  createdAt: iso(0),
                  closedAt: iso(0),
                },
              ],
            },
          }),
          [`GET /api/chat/plans/${EARLIER}`]: () => ({
            status: 200,
            body: rawPlan({ id: EARLIER, title: 'Eski plan', state: 'done' }),
          }),
          [`GET /api/chat/threads/${THREAD}/assets?kind=starred`]: () => ({
            status: 200,
            body: { items: [] },
          }),
        },
      }),
    );
    const details = await screen.findByTestId('dy-details');
    await waitFor(() => {
      expect(within(details).getByRole('tab', { name: 'Planlar' }).getAttribute('aria-selected')).toBe(
        'true',
      );
    });
    const dialog = await screen.findByTestId('details-plan-dialog');
    expect(await within(dialog).findByText('Kapanmış bir plan — yalnızca okunur.')).toBeTruthy();
  });
});
