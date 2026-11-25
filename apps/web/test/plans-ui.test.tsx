// p18-plans-ui (docs/design/p18-plan-mode.md, "Plans UI"): the chat details panel's tab grid (every tab visible at the
// panel's widths, no sideways scrolling, arrow keys, remembered tab, count badges, no "Ayrıntılar" heading), its Planlar
// tab (the active plan's summary, "Planı aç", earlier plans read only, the empty state) and the Planlar screen
// (`GET /chat/plans`: the overview, the filters, the cards and their link into the conversation).
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Plan, parsePlan } from '../src/api/plans';
import { DetailsPanel, nextTab } from '../src/diyalog/chat/DetailsPanel';
import { planHref } from '../src/diyalog/chat/route';
import { EXEC_PLAN, PLAN_THREAD_ID } from '../src/diyalog/harness/planFixtures';
import { overviewParts } from '../src/diyalog/screens/plans/PlansScreen';
import { messagesFor } from '@remyral/i18n';
import type { AuthState } from '../src/auth/AuthProvider';
import { fakeFetch, type Handler, renderApp, sessionBody, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const T = PLAN_THREAD_ID;
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const EMPTY = ok({ items: [] });
const PLAN = parsePlan(EXEC_PLAN) as Plan;
const EARLIER_ID = '0c1d2e3f-0000-4000-8000-0000000000e1';
const HISTORY = ok({
  active: null,
  mode: null,
  history: [
    {
      id: EARLIER_ID,
      title: 'Eski göç planı',
      state: 'cancelled',
      version: 1,
      done: 1,
      total: 3,
      createdAt: '2026-10-20T10:00:00Z',
      closedAt: '2026-10-21T10:00:00Z',
    },
  ],
});

function renderPanel(
  over: Partial<Parameters<typeof DetailsPanel>[0]> = {},
  routes: Record<string, Handler> = {},
) {
  const { fetch, requests } = fakeFetch({
    [`GET /api/chat/threads/${T}/assets?kind=starred`]: EMPTY,
    [`GET /api/chat/threads/${T}/assets?kind=media`]: EMPTY,
    [`GET /api/chat/threads/${T}/assets?kind=links`]: EMPTY,
    [`GET /api/chat/threads/${T}/assets?kind=files`]: EMPTY,
    [`GET /api/chat/threads/${T}/assets?kind=jobs`]: EMPTY,
    [`GET /api/chat/threads/${T}/plans`]: HISTORY,
    [`GET /api/chat/watches?threadId=${T}`]: EMPTY,
    ...routes,
  });
  vi.stubGlobal('fetch', fetch);
  const onOpenPlan = vi.fn();
  const view = render(
    <MemoryRouter>
      <div data-ui="diyalog">
        <DetailsPanel threadId={T} onClose={vi.fn()} onJump={vi.fn()} onOpenPlan={onOpenPlan} {...over} />
      </div>
    </MemoryRouter>,
  );
  return { onOpenPlan, requests, view };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('details tab grid (p18-plans-ui)', () => {
  it('shows every tab at once in a 4-column grid — nothing scrolls sideways — and no "Ayrıntılar" heading', () => {
    renderPanel();
    const panel = screen.getByRole('complementary', { name: 'Sohbet ayrıntıları' });
    expect(within(panel).queryByRole('heading')).toBeNull();
    const list = within(panel).getByRole('tablist');
    expect(list.className).toContain('grid-cols-4');
    expect(list.className).not.toMatch(/overflow-x|flex-nowrap|whitespace-nowrap/);
    expect(list.getAttribute('data-columns')).toBe('4');
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Yıldızlı',
      'Görseller',
      'Bağlantılar',
      'Dosyalar',
      'İşler',
      'Takipler',
      'Planlar',
    ]);
    // Each tab is a grid cell (no fixed width wider than a quarter of the 320 px column) and none is hidden.
    for (const t of tabs) {
      expect(t.className).toContain('min-w-0');
      expect(t.className).not.toMatch(/shrink-0|px-3|w-\[/);
      expect(t.hidden).toBe(false);
    }
    // The panel keeps its widths (320 / 352 px) and the close button.
    expect(panel.className).toContain('lg:w-[320px]');
    expect(panel.className).toContain('xl:w-[352px]');
    expect(within(panel).getByRole('button', { name: 'Ayrıntıları kapat' })).toBeTruthy();
  });

  it('arrow keys move between the tabs (roving tabindex): ←/→ wrap, ↑/↓ by row, Home / End', () => {
    expect(nextTab(0, 7, 'ArrowRight')).toBe(1);
    expect(nextTab(6, 7, 'ArrowRight')).toBe(0);
    expect(nextTab(0, 7, 'ArrowLeft')).toBe(6);
    expect(nextTab(1, 7, 'ArrowDown')).toBe(5);
    expect(nextTab(3, 7, 'ArrowDown')).toBe(6);
    expect(nextTab(5, 7, 'ArrowDown')).toBe(5);
    expect(nextTab(5, 7, 'ArrowUp')).toBe(1);
    expect(nextTab(2, 7, 'ArrowUp')).toBe(2);
    expect(nextTab(3, 7, 'Home')).toBe(0);
    expect(nextTab(3, 7, 'End')).toBe(6);
    expect(nextTab(3, 7, 'a')).toBeNull();

    renderPanel();
    const list = screen.getByRole('tablist');
    const tab = (name: string) => within(list).getByRole('tab', { name });
    expect(tab('Yıldızlı').tabIndex).toBe(0);
    expect(tab('Görseller').tabIndex).toBe(-1);
    tab('Yıldızlı').focus();
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('Görseller'));
    expect(tab('Görseller').getAttribute('aria-selected')).toBe('true');
    expect(tab('Görseller').tabIndex).toBe(0);
    expect(tab('Yıldızlı').tabIndex).toBe(-1);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(tab('Takipler'));
    fireEvent.keyDown(list, { key: 'End' });
    expect(document.activeElement).toBe(tab('Planlar'));
    expect(screen.getByRole('tabpanel').getAttribute('data-tab')).toBe('plans');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('Yıldızlı'));
    // Focus is visible.
    expect(tab('Yıldızlı').className).toContain('focus-visible:ring-2');
  });

  it('remembers the last tab for the next conversation', async () => {
    const user = userEvent.setup();
    const { view } = renderPanel();
    await user.click(screen.getByRole('tab', { name: 'Bağlantılar' }));
    view.unmount();
    renderPanel();
    expect(screen.getByRole('tab', { name: 'Bağlantılar' }).getAttribute('aria-selected')).toBe('true');
  });

  it('counts are small badges that keep the tab’s name (what waits in the plan, the watches)', () => {
    renderPanel({ plan: PLAN, watchCount: 2 });
    const plans = screen.getByRole('tab', { name: 'Planlar' });
    // One open decision, a card to confirm (smoke) and the person's own ready item (etiket).
    const badge = screen.getByTestId('details-badge-plans');
    expect(badge.getAttribute('data-count')).toBe('3');
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(plans.textContent).toBe('Planlar');
    const describedBy = plans.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe('3 şey senden bekliyor');
    expect(screen.getByTestId('details-badge-watches').getAttribute('data-count')).toBe('2');
    expect(screen.queryByTestId('details-badge-starred')).toBeNull();
  });
});

describe('Planlar tab (p18-plans-ui)', () => {
  it('summarises the active plan and "Planı aç" opens the plan panel', async () => {
    const user = userEvent.setup();
    const { onOpenPlan } = renderPanel({ plan: PLAN });
    await user.click(screen.getByRole('tab', { name: 'Planlar' }));
    const active = await screen.findByTestId('details-plan-active');
    expect(within(active).getByRole('heading', { name: PLAN.title })).toBeTruthy();
    expect(within(active).getByTestId('plan-autonomous')).toBeTruthy();
    expect(within(active).getByText('Yürütülüyor')).toBeTruthy();
    expect(within(active).getByTestId('details-plan-progress').textContent).toBe('4/9 · ~4 sa 45 dk kaldı');
    expect(within(active).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('44');
    expect(within(active).getByTestId('details-plan-decisions').textContent).toContain('Deploy ortamı?');
    const waiting = within(active).getByTestId('details-plan-waiting');
    expect(waiting.textContent).toContain('Smoke testlerini çalıştır — Kart onayını bekliyor');
    expect(waiting.textContent).toContain('Sürüm etiketi koy — Senin maddenin sırası geldi');
    // No "Tüm sohbetlerim" on this tab.
    expect(screen.queryByRole('checkbox', { name: 'Tüm sohbetlerim' })).toBeNull();
    await user.click(within(active).getByRole('button', { name: 'Planı aç' }));
    expect(onOpenPlan).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Tüm planlar' }).getAttribute('href')).toBe('/plans');
  });

  it('lists the earlier plans; one opens read only', async () => {
    const user = userEvent.setup();
    renderPanel(
      { plan: null },
      {
        [`GET /api/chat/plans/${EARLIER_ID}`]: ok({
          ...EXEC_PLAN,
          id: EARLIER_ID,
          title: 'Eski göç planı',
          state: 'cancelled',
        }),
      },
    );
    await user.click(screen.getByRole('tab', { name: 'Planlar' }));
    // No active plan: the empty state.
    expect((await screen.findByTestId('details-empty')).textContent).toContain('Bu sohbette plan yok');
    const earlier = await screen.findByTestId('details-plan-earlier');
    const row = within(earlier).getByRole('button', { name: 'Önceki planı göster: Eski göç planı' });
    expect(row.textContent).toContain('İptal edildi');
    expect(row.textContent).toContain('1/3');
    await user.click(row);
    const dialog = await screen.findByTestId('details-plan-dialog');
    expect(await within(dialog).findByText('Kapanmış bir plan — yalnızca okunur.')).toBeTruthy();
    expect(within(dialog).getByText('Sürüm etiketi koy')).toBeTruthy();
    // Read only: no editing controls.
    expect(within(dialog).queryByRole('button', { name: /Düzenle|Onayla/ })).toBeNull();
  });

  it('a plan link opens the tab and the earlier plan', async () => {
    renderPanel(
      { plan: PLAN, planRequest: { id: EARLIER_ID, n: 1 } },
      {
        [`GET /api/chat/plans/${EARLIER_ID}`]: ok({
          ...EXEC_PLAN,
          id: EARLIER_ID,
          state: 'done',
        }),
      },
    );
    expect(screen.getByRole('tab', { name: 'Planlar' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByTestId('details-plan-dialog')).toBeTruthy();
  });

  it('a link to the active plan opens the plan panel instead', async () => {
    const { onOpenPlan } = renderPanel({ plan: PLAN, planRequest: { id: PLAN.id, n: 1 } });
    await waitFor(() => {
      expect(onOpenPlan).toHaveBeenCalledTimes(1);
    });
  });
});

/* ------------------------------------------------------------------ the Planlar screen */

const P1 = '0c1d2e3f-0000-4000-8000-0000000000a1';
const P2 = '0c1d2e3f-0000-4000-8000-0000000000a2';
const COUNTS = {
  total: 7,
  active: 5,
  executing: 3,
  review: 1,
  paused: 1,
  done: 2,
  cancelled: 0,
  needsYou: 2,
};
function row(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    threadId: T,
    threadTitle: 'Sürüm sohbeti',
    archived: false,
    role: 'owner',
    title: 'Sürüm 2.4',
    state: 'executing',
    autonomous: true,
    stalled: null,
    version: 2,
    progress: { done: 4, total: 9, skipped: 0, remainingMinutes: 90 },
    openDecisions: 1,
    waiting: 2,
    needsYou: true,
    projects: ['mobil-app'],
    createdAt: '2026-10-28T10:00:00Z',
    updatedAt: new Date().toISOString(),
    closedAt: null,
    ...over,
  };
}

const signedIn: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };

function renderScreen(routes: Record<string, Handler> = {}, path = '/plans') {
  return renderApp({
    path,
    initialState: signedIn,
    routes: {
      'GET /api/auth/session': ok(sessionBody()),
      'GET /api/approvals?status=pending': ok({ items: [], nextCursor: null }),
      'GET /api/workers': ok({ workers: [] }),
      'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
      'GET /api/chat/plans': ok({
        items: [
          row(P1),
          row(P2, {
            title: 'Paylaşılan plan',
            role: 'reader',
            state: 'done',
            autonomous: false,
            needsYou: false,
            openDecisions: 0,
            waiting: 0,
          }),
        ],
        next: null,
        counts: COUNTS,
      }),
      'GET /api/chat/plans?filter=executing': ok({ items: [row(P1)], next: null, counts: COUNTS }),
      'GET /api/chat/plans?q=yok': ok({ items: [], next: null, counts: COUNTS }),
      'GET /api/projects': ok({
        items: [
          {
            id: 'mobil-app',
            name: 'Mobil uygulama',
            kind: 'repository',
            createdAt: '2026-10-01T00:00:00Z',
            createdBy: null,
            members: 1,
            myRole: 'owner',
          },
        ],
      }),
      ...routes,
    },
  });
}

describe('Planlar screen (p18-plans-ui)', () => {
  it('the overview line counts what matters, most pressing first', () => {
    const s = messagesFor('tr').plan.screen;
    expect(overviewParts(COUNTS, s)).toEqual([
      '3 yürütülüyor',
      '2 senden bekliyor',
      '1 incelemede',
      '1 duraklatıldı',
      '2 bitti',
    ]);
    expect(overviewParts({ ...COUNTS, executing: 0, needsYou: 0, review: 0, paused: 0, done: 0 }, s)).toEqual(
      [],
    );
  });

  it('lists every plan as a card with its state, progress, waits and the link into the conversation', async () => {
    renderScreen();
    expect(await screen.findByRole('heading', { level: 1, name: 'Planlar' })).toBeTruthy();
    // The rail has the entry, marked as the current page.
    const rail = screen
      .getAllByRole('link', { name: 'Planlar' })
      .find((a) => a.getAttribute('href') === '/plans');
    expect(rail).toBeTruthy();
    const overview = await screen.findByTestId('plans-overview');
    expect(overview.textContent).toContain('7 plan');
    expect(overview.textContent).toContain('3 yürütülüyor');
    expect(overview.textContent).toContain('2 senden bekliyor');
    const cards = await screen.findAllByTestId('plans-card');
    expect(cards).toHaveLength(2);
    const first = cards[0] as HTMLElement;
    expect(first.getAttribute('href')).toBe(planHref(T, P1));
    expect(first.getAttribute('href')).toBe(`/chat/${T}?plan=${P1}`);
    expect(first.getAttribute('aria-label')).toBe('Planı sohbette aç: Sürüm 2.4');
    expect(within(first).getByText('Yürütülüyor')).toBeTruthy();
    expect(within(first).getByTestId('plan-autonomous')).toBeTruthy();
    expect(within(first).getByText('Senden bekliyor')).toBeTruthy();
    expect(within(first).getByTestId('plans-progress').textContent).toBe('4/9');
    expect(first.textContent).toContain('~1 sa 30 dk kaldı');
    expect(first.textContent).toContain('1 karar bekliyor');
    expect(first.textContent).toContain('2 madde seni bekliyor');
    expect(first.textContent).toContain('Sohbet: Sürüm sohbeti');
    expect(await within(first).findByText('Mobil uygulama')).toBeTruthy();
    const second = cards[1] as HTMLElement;
    expect(within(second).getByText('Paylaşılan')).toBeTruthy();
    expect(within(second).queryByText('Senden bekliyor')).toBeNull();
    // The filter buttons carry their counts.
    const filters = screen.getByTestId('plans-filters');
    expect(within(filters).getByRole('button', { name: /^Yürütülüyor/ }).textContent).toBe('Yürütülüyor3');
    expect(within(filters).getByRole('button', { name: /^Tümü/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('filters by state and search; an empty result offers to clear the filters', async () => {
    const user = userEvent.setup();
    const { requests } = renderScreen();
    await screen.findAllByTestId('plans-card');
    await user.click(
      within(screen.getByTestId('plans-filters')).getByRole('button', { name: /^Yürütülüyor/ }),
    );
    await waitFor(() => {
      expect(requests.some((r) => r.url === '/api/chat/plans?filter=executing')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('plans-card')).toHaveLength(1);
    });
    expect(
      within(screen.getByTestId('plans-filters'))
        .getByRole('button', { name: /^Yürütülüyor/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    await user.click(within(screen.getByTestId('plans-filters')).getByRole('button', { name: /^Tümü/ }));
    await user.type(screen.getByRole('searchbox', { name: 'Ara' }), 'yok');
    const empty = await screen.findByTestId('plans-empty');
    expect(empty.textContent).toContain('Bu filtrelere uyan plan yok.');
    await user.click(within(empty).getByRole('button', { name: 'Filtreleri temizle' }));
    expect(await screen.findAllByTestId('plans-card')).toHaveLength(2);
  });

  it('says when there is no plan yet', async () => {
    renderScreen({ 'GET /api/chat/plans': ok({ items: [], next: null, counts: { ...COUNTS, total: 0 } }) });
    expect((await screen.findByTestId('plans-empty')).textContent).toContain('Henüz plan yok');
  });
});
