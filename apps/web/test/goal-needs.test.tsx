// p20-outcome (docs/design/p20-outcome-contract.md, "The intervention card"): a goal that cannot move on by itself is
// ONE card on "Senden bekleyen" — what was asked, what happened (the coded reason in words plus the concrete detail),
// the next step, what the person has to do — with "Devam ettir", "Vazgeç" (confirmed inline) and "Sohbete git". A plan
// goal whose plan already has its card is not drawn twice; goal texts render as plain text.
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { messagesFor } from '@remyral/i18n';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Goal, parseGoal } from '../src/api/goals';
import { GoalNeeds } from '../src/diyalog/screens/needs/GoalNeeds';
import { fakeFetch, stubCookies } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const TR = messagesFor('tr');
const GOAL = '9a0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e71';
const PLAN_GOAL = '9b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e71';
const THREAD = '6b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e71';
const WATCH = '7c0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e71';
const PLAN = '8d0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e71';
const NOW = new Date().toISOString();

function goalBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: GOAL,
    threadId: THREAD,
    threadTitle: 'Önizleme servisi',
    origin: { kind: 'watch', id: WATCH },
    title: 'tasarim-onizleme ayakta',
    outcomeCondition: 'Önizleme adresi yanıt veriyor',
    nextAction: 'user_action',
    nextNote: null,
    owner: 'user',
    blockedReason: 'follow_up_cap',
    reevaluateAt: null,
    state: 'intervention',
    detail: 'Servis durdu (failed): exit 1',
    userAction: null,
    interventions: 1,
    links: [{ kind: 'watch', id: WATCH }],
    openedAt: NOW,
    updatedAt: NOW,
    interventionAt: NOW,
    closedAt: null,
    ...over,
  };
}

function goal(over: Record<string, unknown> = {}): Goal {
  const g = parseGoal(goalBody(over));
  if (g === null) throw new Error('bad goal');
  return g;
}

beforeEach(() => {
  stubCookies('__Host-remyral_csrf=csrf-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('"Senden bekleyen": intervention cards (p20-outcome)', () => {
  it('parses a goal defensively (unknown origin / state dropped)', () => {
    expect(goal().blockedReason).toBe('follow_up_cap');
    expect(parseGoal(goalBody({ origin: { kind: 'nope', id: WATCH } }))).toBeNull();
    expect(parseGoal(goalBody({ state: 'weird' }))).toBeNull();
    expect(parseGoal({ id: 1 })).toBeNull();
  });

  it('one card per goal: what was asked, what happened, what to do; "Sohbete git" links the conversation', () => {
    render(
      <MemoryRouter>
        <GoalNeeds goals={[goal()]} onChanged={vi.fn()} />
      </MemoryRouter>,
    );
    const cards = screen.getAllByTestId('goal-need');
    expect(cards).toHaveLength(1);
    const card = cards[0] as HTMLElement;
    expect(within(card).getByRole('heading', { name: 'tasarim-onizleme ayakta' })).toBeTruthy();
    expect(within(card).getByTestId('goal-need-asked').textContent).toContain(
      'Önizleme adresi yanıt veriyor',
    );
    const happened = within(card).getByTestId('goal-need-happened').textContent;
    expect(happened).toContain(TR.goals.reason.follow_up_cap);
    expect(happened).toContain('Servis durdu (failed): exit 1');
    expect(within(card).getByTestId('goal-need-you').textContent).toContain(TR.goals.action.follow_up_cap);
    expect(within(card).getByTestId('goal-need-chat').getAttribute('href')).toBe(`/chat/${THREAD}`);
    expect(screen.getByText(TR.goals.section.count({ n: 1 }))).toBeTruthy();
  });

  it('the assistant’s own words win over the derived ones; text is never markup', () => {
    render(
      <MemoryRouter>
        <GoalNeeds
          goals={[
            goal({
              blockedReason: 'assistant_declared',
              userAction: '<b>Cloudflare</b> anahtarını kasaya ekle',
              nextNote: 'Anahtar gelince yayına alacağım',
            }),
          ]}
          onChanged={vi.fn()}
        />
      </MemoryRouter>,
    );
    const card = screen.getByTestId('goal-need');
    expect(within(card).getByTestId('goal-need-you').textContent).toBe(
      `${TR.goals.card.you}<b>Cloudflare</b> anahtarını kasaya ekle`,
    );
    expect(card.querySelector('b b')).toBeNull();
    expect(within(card).getByTestId('goal-need-next').textContent).toContain(
      'Anahtar gelince yayına alacağım',
    );
  });

  it('"Devam ettir" posts the resume; "Vazgeç" asks first, then posts the cancel', async () => {
    const user = userEvent.setup();
    const f = fakeFetch({
      [`POST /api/chat/goals/${GOAL}/resume`]: () => ({
        status: 200,
        body: goalBody({ state: 'open', owner: 'assistant' }),
      }),
      [`POST /api/chat/goals/${GOAL}/cancel`]: () => ({
        status: 200,
        body: goalBody({ state: 'cancelled', closedAt: NOW }),
      }),
    });
    vi.stubGlobal('fetch', f.fetch);
    const changed = vi.fn();
    render(
      <MemoryRouter>
        <GoalNeeds goals={[goal()]} onChanged={changed} />
      </MemoryRouter>,
    );
    const card = screen.getByTestId('goal-need');
    await user.click(within(card).getByTestId('goal-need-resume'));
    await waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId('goal-needs-live').textContent).toBe(TR.goals.card.resumed);

    await user.click(within(card).getByTestId('goal-need-cancel'));
    expect(within(card).getByText(TR.goals.card.cancelConfirm)).toBeTruthy();
    // "Hayır" sends nothing.
    await user.click(within(card).getByRole('button', { name: TR.goals.card.confirmNo }));
    expect(f.requests).toHaveLength(1);
    await user.click(within(card).getByTestId('goal-need-cancel'));
    await user.click(within(card).getByTestId('goal-need-cancel-yes'));
    await waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(2);
    });
    expect(f.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `POST /api/chat/goals/${GOAL}/resume`,
      `POST /api/chat/goals/${GOAL}/cancel`,
    ]);
    expect(screen.getByTestId('goal-needs-live').textContent).toBe(TR.goals.card.cancelled);
  });

  it('a plan goal whose plan has its own card is not drawn twice; nothing waits → no section', () => {
    const planGoal = goal({
      id: PLAN_GOAL,
      origin: { kind: 'plan', id: PLAN },
      blockedReason: 'plan_stalled:budget',
    });
    const { rerender } = render(
      <MemoryRouter>
        <GoalNeeds goals={[goal(), planGoal]} onChanged={vi.fn()} plansShown={new Set([PLAN])} />
      </MemoryRouter>,
    );
    expect(screen.getAllByTestId('goal-need').map((c) => c.getAttribute('data-goal'))).toEqual([GOAL]);
    rerender(
      <MemoryRouter>
        <GoalNeeds goals={[planGoal]} onChanged={vi.fn()} plansShown={new Set()} />
      </MemoryRouter>,
    );
    const card = screen.getByTestId('goal-need');
    expect(within(card).getByTestId('goal-need-happened').textContent).toContain(
      TR.goals.reason.plan_stalled,
    );
    rerender(
      <MemoryRouter>
        <GoalNeeds goals={[]} onChanged={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('dy-goal-needs')).toBeNull();
  });
});
